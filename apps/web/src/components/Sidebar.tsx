import { useOpenChatBeside, isSplittableChat } from "../hooks/useOpenChatBeside";
import { useShallow } from "zustand/react/shallow";
import { usePrivacyLabel, usePrivacyMode } from "~/hooks/usePrivacyMode";
import { TerminalSessionList } from "./sidebar/TerminalSessionList";
import { terminalListEnvironmentId } from "@t3tools/client-runtime/terminal-sessions";
import { pendingThreadSearchJumpAtom } from "@t3tools/client-runtime/state/thread-search";
import { groupComparisonThreads } from "@t3tools/client-runtime/state/model-comparison";
import { connectionWorkLabel } from "@t3tools/client-runtime/connection";
import { sessionBoxConnectionPresentation } from "@t3tools/client-runtime/state/session-boxes";
import { environmentPresentations } from "../state/presentation";
import { serverEnvironment } from "../state/server";
import { harnessMascotIdentity } from "@t3tools/shared/harnessThemes";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { WorkingStatusIndicator } from "./WorkingStatusIndicator";
import { type ScopedProjectRef } from "@t3tools/contracts";
import {
  ThreadHoverCard,
  ThreadHoverCardLastMessage,
  ThreadHoverCardPopup,
} from "./ThreadHoverCard";
import { resolveRenameCommit } from "./chat/ChatHeader";
import { CollapsibleSectionHeader } from "./ui/collapsible-section-header";
import {
  setThreadChangeRequestSnapshot,
  ThreadCpuIndicator,
  ThreadTerminalStatusButton,
} from "./ThreadStatusIndicators";
import { ThreadContextDragGhost } from "./chat/ThreadContextDragGhost";
import {
  dropThreadContext,
  endThreadContextDrag,
  moveThreadContextDrag as moveThreadContextDragGhost,
} from "./chat/threadContextDrag";
import { discardComposerDraft } from "../lib/discardComposerDraft";
import { requestCustomSnooze } from "./CustomSnoozeDialog";
import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/shared/threadPullRequests";
import { useAtomValue } from "@effect/atom-react";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { longRunningFactsForShell, pinnedWaitingLine } from "@t3tools/shared/chatControls";
import { presentBackgroundWaitInThreadRow } from "@t3tools/client-runtime/state/thread-execution";
import * as ThreadUndo from "../hooks/threadUndo";
import { showThreadUndoNotice } from "../hooks/showThreadUndoNotice";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";
import { Persistence } from "@t3tools/client-runtime/platform";
import type { EnvironmentThreadState } from "@t3tools/client-runtime/state/threads";
import { connectionAtomRuntime } from "../connection/runtime";
import {
  DndContext,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Modifier,
} from "@dnd-kit/core";
import { SortableContext, useSortable } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  canSnooze,
  effectiveSnoozed,
  threadWokeAt,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  createInboxReturnTracker,
  failureNeedsYou,
} from "@t3tools/client-runtime/state/thread-inbox";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import {
  resolveSettledThreadTimestamp,
  sortSettledThreads,
} from "@t3tools/client-runtime/state/thread-sort";
import {
  threadSearchMatchKey,
  type EnvironmentThreadSearchMatch,
} from "@t3tools/client-runtime/state/thread-search";
import {
  resolveThreadProviderStack,
  resolveThreadWaitingStartedAt,
  threadRuntimeCanArchive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  CHAT_TAB_NAME_MAX_LENGTH,
  CLAUDE_RC_TAB,
  cleanChatTabName,
  type ChatTabsCommand,
  type ContextMenuItem,
  EnvironmentId,
  type EnvironmentMachineKind,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import {
  ALL_CHATS_TAB,
  buildChatTabs,
  chatTabKey,
  chatTabShowsThread,
  resolveSelectedChatTab,
  type ChatTabView,
} from "@t3tools/client-runtime/state/chat-tabs";

import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  ArrowRightLeftIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotDashedIcon,
  ClockIcon,
  EyeIcon,
  GitBranchIcon,
  HashIcon,
  ChevronRightIcon,
  EllipsisIcon,
  MessageCircleQuestionIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  ShieldQuestionIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useLocation, useParams, useRouter } from "@tanstack/react-router";

import { useRightPanelStore } from "../rightPanelStore";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { isElectron } from "../env";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { useShortcutModifierState } from "../shortcutModifierState";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { isMacPlatform } from "~/lib/utils";
import { useOpenPrLink } from "../lib/openPullRequestLink";
import { readLocalApi } from "../localApi";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import { selectProjectGroupingSettings } from "../logicalProject";
import {
  projectGroupsSpanEnvironments,
  getSidebarProjectSettingsKey,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import { useUiStateStore } from "../uiStateStore";
import {
  getThreadKeysToDeselectAfterDelete,
  useThreadSelectionStore,
} from "../threadSelectionStore";
import { useAcknowledgeThreadWoke, useThreadActions } from "../hooks/useThreadActions";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useScratchProject } from "../hooks/useScratchProject";
import { useSidebarProjectGroups } from "../hooks/useSidebarProjectGroups";
import { useTerminalFocus } from "../hooks/useTerminalFocus";
import { isCommandPaletteOpen, openCommandPalette } from "../commandPaletteBus";
import { registerSettleAndAdvance } from "../settleAndAdvance";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { useClientSettings } from "../hooks/useSettings";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useAtomCommand } from "../state/use-atom-command";
import { SidebarChatTabs, chatTabDropAt } from "./sidebar/SidebarChatTabs";
import {
  chatTabStripMenuItems,
  isChatTabMenuId,
  moveToChatTabMenuItem,
  parseChatTabMenuId,
  type ChatTabMenuId,
} from "./sidebar/chatTabMenus";
import { SessionBox, SessionBoxPainting } from "./sessionBoxes/SessionBox";
import {
  compareSessionBoxes,
  presentSessionBoxCached,
  sessionBoxFacesFor,
  sessionBoxSiblingShare,
  type SessionBoxPresentation,
} from "@t3tools/client-runtime/state/session-boxes";
import { useUiMode } from "../hooks/useTheme";
import {
  DiscordServerRail,
  DiscordMachineHeader,
  DiscordUserPanel,
  MachineFilterMenu,
} from "./discord/DiscordNavigation";
import {
  discordServers,
  groupDiscordChannels,
  machineAttentionCounts,
  machineFilterVisible,
  nextAttentionThreadKey,
  threadIsUnread,
  threadNeedsYouCount,
} from "./discord/discordShell.logic";
import { DiscordServerSettings } from "./discord/DiscordServerSettings";
import { useEnvironments } from "../state/environments";
import { useSidebarLayout } from "./sessionBoxes/sidebarLayout";
import { useNowMinute, useNowMinuteMs } from "../hooks/useNowMinute";
import {
  useEnvironmentIdentities,
  useConnectedEnvironmentIds,
  useEnvironmentMachines,
  usePrimaryEnvironmentId,
  usePrimaryEnvironmentPending,
} from "../state/environments";
import {
  readThreadShell,
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../state/entities";
import { environmentServerConfigsAtom, primaryServerKeybindingsAtom } from "../state/server";
import { vcsEnvironment } from "../state/vcs";
import { environmentThreadDetails, threadEnvironment } from "../state/threads";
import { useEnvironmentQuery } from "../state/query";
import { useThreadSearch } from "../state/queries";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import {
  buildThreadRouteParams,
  resolveActiveThreadRouteRef,
  resolveThreadRouteTarget,
} from "../threadRoutes";
import { formatRelativeTimeLabel, parseTimestampDate } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { cn } from "~/lib/utils";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import {
  buildDraftActionMenuItems,
  buildThreadActionMenuItems,
  threadActionRequiresOperate,
  type ThreadActionMenuId,
} from "./threadActionMenu.logic";
import {
  animateSidebarLayoutChanges,
  applySidebarThreadDrop,
  filterSidebarV2VisibleThreads,
  filterSidebarThreads,
  buildBulkTitleRegenerationContextMenuItem,
  buildBulkUnpinContextMenuItem,
  deleteSelectedThreadEntries,
  formatWorkingDurationLabel,
  focusSidebarRow,
  firstValidTimestampMs,
  hasUnseenCompletion,
  isSidebarNestedLinkClick,
  isSidebarThreadWorking,
  isTrailingDoubleClick,
  orderItemsByPreferredIds,
  planSidebarThreadDrop,
  resolveAdjacentThreadId,
  resolveSidebarSearchNavigation,
  shouldActivateSidebarRow,
  resolveSidebarSweepKeys,
  resolveSidebarDropTarget,
  resolveSidebarDropVerb,
  resolveSidebarThreadSection,
  resolveSidebarRowAccessibility,
  type SidebarDropVerb,
  resolveSidebarThreadStatus,
  resolveSidebarDisplayStatus,
  resolveThreadLastVisitedAt,
  searchSidebarThreads,
  rankSidebarSearchResults,
  shouldCreateNewThreadInCurrentProject,
  shouldNavigateAfterThreadPark,
  msUntilQuiet,
  resolveLastActivityAt,
  resolveWorkingStartedAt,
  sidebarListItemId,
  sidebarMessagePreview,
  sidebarPrefetchRevision,
  sidebarLastMessagePreview,
  isSidebarSubagentThread,
  sidebarThreadIsUnread,
  sidebarThreadAttentionLabel,
  sidebarThreadNeedsYou,
  sidebarMarkerId,
  sidebarThreadKeyAtY,
  sortPinnedThreadsForSidebar,
  belongsInSidebarSettledShelf,
  sidebarSessionActivityAt,
  sidebarSessionNeedsYou,
  holdSidebarOrder,
  sortSidebarSessions,
  sortWorkingThreadsBySend,
  useThreadJumpHintVisibility,
  useRetainedValue,
  withoutRemovedCheckout,
  useSidebarRowSubscriptionLease,
  type SidebarListItem,
  type SidebarListMarker,
  type SidebarSection,
  type SidebarQuickFilter,
} from "./Sidebar.logic";
import { resolveLocalCheckoutBranchMismatch } from "./BranchToolbar.logic";
import {
  createSidebarCollisionDetection,
  createSidebarSortingStrategy,
  restrictBelowSidebarLabel,
} from "./Sidebar.drag";
import { SidebarDragLifecycle, SidebarPointerSensor } from "./Sidebar.pointer";
import { createSidebarPrefetch } from "./Sidebar.prefetch";
import { createSidebarPendingActions, type SidebarPendingAction } from "./Sidebar.optimistic";
import { createSidebarListMotion } from "./Sidebar.motion";
import {
  ThreadPullRequestBadgeControl,
  ThreadPullRequestsMiniList,
  ThreadWorktreeIndicator,
  nextThreadChangeRequestSnapshot,
  prStatusIndicator,
  resolveThreadPullRequestBadge,
  terminalStatusFromRunningIds,
  threadChangeRequestSnapshotsAtom,
  type ThreadChangeRequestSnapshot,
  type TerminalStatusIndicator,
  useLinkedThreadPullRequest,
  ThreadSearchPullRequestNumber,
} from "./ThreadStatusIndicators";
import { resolveSnoozePresets, snoozeWakeLabel, type SnoozePreset } from "./Sidebar.snooze";
import { ProjectFavicon, type ProjectFaviconProject } from "./ProjectFavicon";
import { ThreadSearchMatchExcerpt } from "./ThreadSearchMatch";
import { makeWorkspaceFileDropHandlers } from "./chat/workspaceFileDrop";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { getTriggerDisplayModelLabel } from "./chat/providerIconUtils";
import {
  deriveProviderEntriesByEnvironment,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../providerInstances";
import { useThreadRunningTerminalIds } from "../state/terminalSessions";
import { useCommittedRef } from "../hooks/useCommittedRef";
import { useStableCallback } from "../hooks/useStableCallback";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { InlineButton } from "./ui/button";
import { SidebarContent, SidebarGroup, useSidebar } from "./ui/sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { SidebarNotesLink } from "./sidebar/SidebarNotesLink";
import { SidebarWorkflowsLink } from "./sidebar/SidebarWorkflowsLink";
import {
  useHiddenWorkflowChatKeys,
  withoutWorkflowRunChats,
} from "./workflows/WorkflowRunChatsTracker";
import { SidebarBoardLink } from "./sidebar/SidebarBoardLink";
import { SidebarOverviewLink } from "./sidebar/SidebarOverviewLink";
import { SidebarThreadHeader } from "./sidebar/SidebarThreadHeader";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { MiddleTruncate } from "./ui/middle-truncate";
import {
  composerDraftHasUserContent,
  DraftId,
  useComposerDraftStore,
  useThreadHasUnsentDraft,
  type ComposerThreadDraftState,
  type DraftSessionState,
} from "../composerDraftStore";

// Settled-tail paging: recent history is the common lookup; the deep tail
// stays behind an explicit Show more.
const EMPTY_PROVIDER_ENTRIES: ReadonlyMap<string, ProviderInstanceEntry> = new Map();
// Collapsed shelves share one empty list so a route change alone does not
// give the sidebar list a new identity.
const EMPTY_THREADS: readonly EnvironmentThreadShell[] = [];

const SESSION_LIST_INITIAL_COUNT = 30;
const SESSION_LIST_PAGE_COUNT = 30;
// Fresh keys deliberately reset both shelves to collapsed for existing users.
const SNOOZED_SHELF_EXPANDED_KEY = "t3code:sidebar:snoozed-expanded";
// Settled history pages like the session list above it: recent wrap-ups are
// the common lookup, the deep tail stays behind Show more.
const SETTLED_TAIL_INITIAL_COUNT = 10;
const SETTLED_TAIL_PAGE_COUNT = 25;
const SETTLED_SHELF_EXPANDED_KEY = "t3code:sidebar:settled-expanded";
const WORKING_SHELF_EXPANDED_KEY = "t3code:sidebar:working-expanded";

// Working beta: when this client saw each thread leave the Working shelf.
// Module scope keeps the inbox order across routes that unmount the sidebar.
const inboxReturns = createInboxReturnTracker();

function canOperateThreads(
  threads: ReadonlyArray<Pick<SidebarThreadSummary, "environmentId">>,
): boolean {
  return threads.every((thread) =>
    readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope),
  );
}

function checkThreadOperations(
  threads: ReadonlyArray<Pick<SidebarThreadSummary, "environmentId">>,
): boolean {
  if (canOperateThreads(threads)) return true;
  toastManager.add({
    type: "error",
    title: "Chat action unavailable",
    description: "This connection cannot change one or more selected chats.",
  });
  return false;
}

function compactSidebarTimeLabel(label: string): string {
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

// Same timestamp the session list sorts by, so a row never reads older than
// the row below it.
function threadTimeLabel(thread: SidebarThreadSummary, nowMs: number): string {
  const timestamp = sidebarSessionActivityAt(thread);
  return timestamp === null
    ? ""
    : compactSidebarTimeLabel(formatRelativeTimeLabel(timestamp, nowMs));
}

// Settled rows read "how long ago did this wrap up", matching their sort
// key: both go through resolveSettledThreadTimestamp so label and order can't
// disagree.
function settledTimeLabel(thread: SidebarThreadSummary, nowMs: number): string {
  const timestamp = resolveSettledThreadTimestamp(thread);
  return timestamp === null
    ? ""
    : compactSidebarTimeLabel(formatRelativeTimeLabel(timestamp, nowMs));
}

// Floats at the row's right edge, vertically centered, while the jump
// modifier is held. An overlay pill instead of an inline slot: the hint
// must neither displace the status/time label (holding ⌘ used to blank
// out "Working") nor shift any layout when it appears. pointer-events-none
// so it never swallows clicks meant for the settle/un-settle buttons it
// can overlap.
function JumpHintBadge(props: { label: string }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-1.5 top-1/2 z-10 inline-flex h-5 -translate-y-1/2 items-center rounded-full border border-border/80 bg-background/95 px-1.5 font-mono text-3xs font-medium tracking-tight text-foreground shadow-sm"
    >
      {props.label}
    </span>
  );
}

/**
 * True once a working chat has shown no activity for SIDEBAR_QUIET_AFTER_MS. One timer per
 * working row, re-armed by every new event, so an active chat never ticks for this.
 */
function useQuietTurn(lastActivityAt: string | null): boolean {
  const lastActivityMs = lastActivityAt === null ? Number.NaN : Date.parse(lastActivityAt);
  const [quiet, setQuiet] = useState(
    () => !Number.isNaN(lastActivityMs) && msUntilQuiet(lastActivityMs, Date.now()) === 0,
  );
  useEffect(() => {
    if (Number.isNaN(lastActivityMs)) {
      setQuiet(false);
      return;
    }
    const remaining = msUntilQuiet(lastActivityMs, Date.now());
    setQuiet(remaining === 0);
    if (remaining === 0) return;
    const id = window.setTimeout(() => setQuiet(true), remaining);
    return () => window.clearTimeout(id);
  }, [lastActivityMs]);
  return quiet;
}

// Only the duration re-renders each second.
function WorkingDuration(props: { startedAt: string | null }) {
  const startedMs = props.startedAt !== null ? Date.parse(props.startedAt) : Number.NaN;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (Number.isNaN(startedMs)) return;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [startedMs]);
  if (Number.isNaN(startedMs)) return null;
  return <span className="tabular-nums">{formatWorkingDurationLabel(now - startedMs)}</span>;
}

function terminalProcessLabel(count: number): string {
  return `${count} terminal ${count === 1 ? "process" : "processes"} running`;
}

function SidebarProviderStack(props: {
  thread: SidebarThreadSummary;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
}) {
  const stack = resolveThreadProviderStack(props.thread);
  const currentInstanceId = stack[stack.length - 1]!;
  const currentEntry = props.providerEntryByInstanceId.get(currentInstanceId) ?? null;
  if (currentEntry === null) return null;
  const showInstanceBadge = shouldShowInstanceBadge(
    currentEntry,
    props.providerEntryByInstanceId.values(),
  );
  const current = (
    <ProviderInstanceIcon
      driverKind={currentEntry.driverKind}
      displayName={currentEntry.displayName}
      accentColor={currentEntry.accentColor}
      acpRegistryAgentId={currentEntry.acpRegistryAgentId}
      acpRegistryIconUrl={currentEntry.acpRegistryIconUrl}
      showBadge={showInstanceBadge}
      // Glyph dims, badge stays saturated; offset matches the composer trigger.
      iconClassName="size-3.5 opacity-60"
    />
  );
  if (stack.length === 1) {
    return <span className="inline-flex shrink-0 items-center">{current}</span>;
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {stack.slice(0, -1).map((instanceId) => {
        const entry = props.providerEntryByInstanceId.get(instanceId);
        if (entry === undefined) return null;
        return (
          <ProviderInstanceIcon
            key={instanceId}
            driverKind={entry.driverKind}
            displayName={entry.displayName}
            acpRegistryAgentId={entry.acpRegistryAgentId}
            acpRegistryIconUrl={entry.acpRegistryIconUrl}
            iconClassName="size-3 opacity-35 grayscale"
          />
        );
      })}
      <span className="relative z-10 inline-flex items-center">{current}</span>
    </span>
  );
}

type SidebarPreview = ReturnType<typeof sidebarMessagePreview>;
type SidebarPrefetch = ReturnType<typeof createSidebarPrefetch<SidebarPreview>>;
type SidebarThreadPrefetch = ReturnType<typeof createSidebarPrefetch<boolean>>;

const SIDEBAR_THREAD_PREFETCH_CACHE_MS = 60_000;
const SIDEBAR_THREAD_POINTER_DOWN_HANDOFF_MS = 1_500;

async function prefetchSidebarThread(key: string, signal: AbortSignal): Promise<boolean> {
  const ref = parseScopedThreadKey(key);
  if (!ref || signal.aborted) return false;
  const atom = environmentThreadDetails.stateAtom(ref);
  const node = appAtomRegistry.getNodes().get(atom) as
    | AtomRegistry.Node<EnvironmentThreadState>
    | undefined;
  const existing = node && Option.getOrNull(node.valueOption());
  if (existing && existing.status === "live" && Option.isSome(existing.data)) return true;
  return new Promise<boolean>((resolve, reject) => {
    let finished = false;
    let release = () => {};
    let unsubscribe = () => {};
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      unsubscribe();
      release();
    };
    const succeed = (warmed: boolean) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(warmed);
    };
    const fail = (reason: string) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new Error(reason));
    };
    const abort = () => succeed(false);
    const timeout = setTimeout(() => fail("timeout"), 5_000);
    const observe = (state: EnvironmentThreadState) => {
      if (state.status === "deleted") succeed(true);
      else if (Option.isSome(state.error)) fail(state.error.value);
      else if (state.status === "live" && Option.isSome(state.data)) succeed(true);
    };
    release = appAtomRegistry.mount(atom);
    unsubscribe = appAtomRegistry.subscribe(atom, observe);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else observe(appAtomRegistry.get(atom));
  });
}

async function loadSidebarPreview(key: string, signal: AbortSignal): Promise<SidebarPreview> {
  const ref = parseScopedThreadKey(key);
  if (!ref || signal.aborted) return null;
  const atom = environmentThreadDetails.stateAtom(ref);
  const node = appAtomRegistry.getNodes().get(atom) as
    | AtomRegistry.Node<EnvironmentThreadState>
    | undefined;
  const existing = node && Option.getOrNull(node.valueOption());
  if (existing && Option.isSome(existing.data))
    return sidebarLastMessagePreview(existing.data.value.visibleTurnItems);
  const services = Option.getOrNull(AsyncResult.value(appAtomRegistry.get(connectionAtomRuntime)));
  if (!services) return null;
  const cache = Context.get(services, Persistence.EnvironmentCacheStore);
  // The preview read skips decoding the whole cached thread, which blocked the
  // window for long chats while the pointer crossed the sidebar.
  if (cache.loadThreadPreview) {
    const cachedPreview = await Effect.runPromise(
      cache.loadThreadPreview(ref.environmentId, ref.threadId),
      { signal },
    );
    if (signal.aborted) return null;
    if (Option.isSome(cachedPreview)) return sidebarMessagePreview(cachedPreview.value);
  } else {
    const cached = await Effect.runPromise(cache.loadThread(ref.environmentId, ref.threadId), {
      signal,
    });
    if (signal.aborted) return null;
    if (Option.isSome(cached))
      return sidebarLastMessagePreview(cached.value.projection.visibleTurnItems);
  }
  return new Promise<SidebarPreview>((resolve) => {
    let finished = false;
    let release = () => {};
    let unsubscribe = () => {};
    const finish = (preview: SidebarPreview) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      unsubscribe();
      release();
      resolve(preview);
    };
    const abort = () => finish(null);
    const timeout = setTimeout(abort, 5_000);
    const observe = (state: EnvironmentThreadState) => {
      if (state.status === "deleted" || Option.isSome(state.error)) finish(null);
      else if (state.status === "live" && Option.isSome(state.data))
        finish(sidebarLastMessagePreview(state.data.value.visibleTurnItems));
    };
    release = appAtomRegistry.mount(atom);
    unsubscribe = appAtomRegistry.subscribe(atom, observe);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else observe(appAtomRegistry.get(atom));
  });
}

function useSidebarPrefetchIntent(
  key: string,
  prefetch: SidebarPrefetch,
  threadPrefetch: SidebarThreadPrefetch,
  revision: string,
  skipThreadPrefetch: boolean,
) {
  const pointer = useRef<(() => void) | null>(null);
  const pointerDown = useRef<(() => void) | null>(null);
  const pointerDownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focus = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      pointer.current?.();
      focus.current?.();
      if (pointerDownTimer.current !== null) {
        clearTimeout(pointerDownTimer.current);
        pointerDownTimer.current = null;
      }
      pointerDown.current?.();
      pointerDown.current = null;
    },
    [key, prefetch, threadPrefetch],
  );
  return {
    onPointerEnter: (event: ReactPointerEvent) => {
      if (event.pointerType !== "mouse" || event.buttons !== 0) return;
      pointer.current?.();
      pointer.current = prefetch.request(key, revision);
    },
    onPointerLeave: () => {
      pointer.current?.();
      pointer.current = null;
    },
    // Only a press warms the whole chat. Hover and focus would pull a snapshot for
    // every row passed over, which costs real bandwidth on remote connections, and
    // the web app has no reliable signal that a connection is local.
    onPointerDown: (event: ReactPointerEvent) => {
      if (
        skipThreadPrefetch ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      if (pointerDownTimer.current !== null) clearTimeout(pointerDownTimer.current);
      pointerDown.current?.();
      const release = threadPrefetch.request(key, revision, { immediate: true });
      pointerDown.current = release;
      pointerDownTimer.current = setTimeout(() => {
        pointerDownTimer.current = null;
        if (pointerDown.current === release) {
          pointerDown.current = null;
          release();
        }
      }, SIDEBAR_THREAD_POINTER_DOWN_HANDOFF_MS);
    },
    onFocus: (event: ReactFocusEvent) => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))
        return;
      focus.current?.();
      focus.current = prefetch.request(key, revision);
    },
    onBlur: (event: ReactFocusEvent) => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))
        return;
      focus.current?.();
      focus.current = null;
    },
  };
}

function SidebarThreadMessagePreview({
  thread,
  prefetch,
}: {
  thread: SidebarThreadSummary;
  prefetch: SidebarPrefetch;
}) {
  const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const revision = sidebarPrefetchRevision(thread);
  const { isMobile, open, openMobile } = useSidebar();
  useEffect(() => {
    if (!(isMobile ? openMobile : open) || document.hidden) return;
    return prefetch.request(key, revision);
  }, [isMobile, open, openMobile, key, prefetch, revision]);
  const subscribe = useCallback(
    (listener: () => void) => prefetch.subscribe(key, listener),
    [key, prefetch],
  );
  const snapshot = useCallback(() => prefetch.snapshot(key), [key, prefetch]);
  const cachedPreview = useSyncExternalStore(subscribe, snapshot, snapshot);
  return (
    <ThreadHoverCardLastMessage
      preview={cachedPreview ?? sidebarMessagePreview(thread.source.latestVisibleMessage)}
    />
  );
}

function SidebarThreadTooltip({
  thread,
  prefetch,
  project,
  projectDisplayName,
  environmentLabel,
  environmentMachine,
  providerEntry,
  providerEntryByInstanceId,
  showInstanceBadge,
  modelInstanceId,
  modelLabel,
  branchMismatch,
  terminalStatus,
  terminalProcessCount,
}: {
  thread: SidebarThreadSummary;
  prefetch: SidebarPrefetch;
  project: ProjectFaviconProject | null;
  projectDisplayName: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  providerEntry: ProviderInstanceEntry | null;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
  showInstanceBadge: boolean;
  modelInstanceId: string;
  modelLabel: string;
  branchMismatch: {
    threadBranch: string;
    currentBranch: string;
  } | null;
  terminalStatus: TerminalStatusIndicator | null;
  terminalProcessCount: number;
}) {
  const privateLabel = usePrivacyLabel();
  const privacy = usePrivacyMode();
  const driverKind = providerEntry?.driverKind ?? null;
  const previousProviderNames = thread.providerInstanceHistory
    .filter((instanceId) => instanceId !== modelInstanceId)
    .map((instanceId) => providerEntryByInstanceId.get(instanceId)?.displayName ?? instanceId);
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(thread.environmentId);
  if (privacy)
    return (
      <ThreadHoverCardPopup side="right" align="start" sideOffset={4} className="w-64">
        <ThreadHoverCard title={privateLabel("Chat", thread.id, thread.title)}>
          <p className="text-xs text-muted-foreground">
            Details hidden while screen recording privacy is on.
          </p>
        </ThreadHoverCard>
      </ThreadHoverCardPopup>
    );
  return (
    <ThreadHoverCardPopup side="right" align="start" sideOffset={4} className="w-64">
      <ThreadHoverCard
        title={privateLabel("Chat", thread.id, thread.title)}
        footer={
          <>
            <SidebarThreadMessagePreview thread={thread} prefetch={prefetch} />
            {supportsMultiplePullRequests && thread.pullRequests.length > 0 ? (
              <div className="border-t border-border/60 pt-2 pl-0.5 text-xs text-muted-foreground">
                <ThreadPullRequestsMiniList pullRequests={thread.pullRequests} />
              </div>
            ) : null}
          </>
        }
      >
        {projectDisplayName ? (
          <div className="flex min-w-0 items-center gap-2">
            {project ? <ProjectFavicon project={project} className="size-3 shrink-0" /> : null}
            <div className="min-w-0 truncate text-foreground/75">{projectDisplayName}</div>
          </div>
        ) : null}
        {environmentLabel ? (
          <div className="flex min-w-0 items-center gap-2">
            <EnvironmentMachineIcon
              kind={environmentMachine}
              className="size-3 shrink-0 stroke-muted-foreground"
            />
            <div className="min-w-0 truncate text-foreground/75">{environmentLabel}</div>
          </div>
        ) : null}
        {thread.branch ? (
          <div className="flex min-w-0 items-center gap-2">
            <GitBranchIcon className="size-3 shrink-0 stroke-muted-foreground" />
            <MiddleTruncate value={thread.branch} className="flex" />
          </div>
        ) : null}
        {branchMismatch ? (
          <div className="flex min-w-0 items-start gap-2 text-warning-foreground">
            <CircleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0 stroke-current" />
            <div className="min-w-0 flex-1 wrap-break-word leading-5">
              You're currently checked out on another branch.
            </div>
          </div>
        ) : null}
        {driverKind ? (
          <div className="flex min-w-0 items-center gap-2">
            <ProviderInstanceIcon
              driverKind={driverKind}
              displayName={
                providerEntry?.displayName ?? thread.runtime?.providerName ?? modelInstanceId
              }
              accentColor={providerEntry?.accentColor}
              acpRegistryAgentId={providerEntry?.acpRegistryAgentId}
              acpRegistryIconUrl={providerEntry?.acpRegistryIconUrl}
              // Initials would swallow a size-3 glyph: accent dot, name in label.
              showBadge={showInstanceBadge && providerEntry?.accentColor !== undefined}
              iconClassName="size-3 shrink-0 grayscale opacity-60"
            />
            <div className="min-w-0 truncate text-foreground/75">
              {showInstanceBadge && providerEntry
                ? `${modelLabel} · ${providerEntry.displayName}`
                : modelLabel}
            </div>
          </div>
        ) : null}
        {previousProviderNames.length > 0 ? (
          <div className="flex min-w-0 items-center gap-2">
            <ArrowRightLeftIcon className="size-3 shrink-0 stroke-muted-foreground" />
            <div className="min-w-0 truncate text-foreground/75">
              Handed off from {previousProviderNames.join(", ")}
            </div>
          </div>
        ) : null}
        {terminalStatus ? (
          <div className="flex min-w-0 items-center gap-2">
            <TerminalIcon
              aria-hidden
              className={cn("size-3 shrink-0", terminalStatus.colorClass)}
            />
            <div className="min-w-0 truncate text-foreground/75">
              {terminalProcessLabel(terminalProcessCount)}
            </div>
          </div>
        ) : null}
        {thread.runtime?.lastError ? (
          <div
            className={cn(
              "flex min-w-0 items-center gap-2",
              thread.runtime.lastErrorClass === "usage_limit"
                ? "text-warning-foreground"
                : "text-error-foreground",
            )}
          >
            <CircleAlertIcon className="size-3 shrink-0 stroke-current" />
            <div className="min-w-0 truncate">
              {thread.runtime.lastErrorClass === "usage_limit"
                ? "Usage limit reached"
                : "Error occurred"}
            </div>
          </div>
        ) : null}
      </ThreadHoverCard>
    </ThreadHoverCardPopup>
  );
}

/**
 * Hover entry point for snooze: a clock button opening the preset menu.
 * Controlled by the row (which also uses the open state to pin its hover
 * actions while the menu is up).
 */
function SnoozeMenuButton(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSnooze: (preset: Pick<SnoozePreset, "snoozedUntil">) => void;
  timestampFormat: TimestampFormat;
}) {
  const { open, onOpenChange, onSnooze, timestampFormat } = props;
  // Presets resolve at open time so "In 1 hour" is relative to the click,
  // not to when the row mounted.
  const presets = useMemo(
    () => (open ? resolveSnoozePresets(new Date(), timestampFormat) : []),
    [open, timestampFormat],
  );
  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label="Snooze chat"
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  className="inline-flex h-full cursor-pointer items-center gap-0.5 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                />
              }
            />
          }
        >
          <ClockIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup>Snooze chat</TooltipPopup>
      </Tooltip>
      <MenuPopup side="bottom" align="end">
        {presets.map((preset) => (
          <MenuItem
            key={preset.id}
            onClick={(event) => {
              event.stopPropagation();
              onSnooze(preset);
            }}
          >
            {preset.label}
            <MenuShortcut>{preset.whenLabel}</MenuShortcut>
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem
          onClick={async (event) => {
            event.stopPropagation();
            const choice = await requestCustomSnooze();
            if (choice) onSnooze(choice);
          }}
        >
          Custom…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

// Subset of useSortable applied to a thread row's root <li>. Listeners go
// on the whole row (no dedicated handle): the pointer sensor's distance
// constraint keeps plain clicks working, and we skip dnd-kit's aria
// attributes since there is no keyboard sensor and the row body already
// carries its own button semantics.
type SortableThreadRowBag = Pick<
  ReturnType<typeof useSortable>,
  "listeners" | "setNodeRef" | "transform" | "transition" | "isDragging"
>;

function SortableThreadRow(props: {
  id: string;
  disabled: boolean;
  contextDrag: boolean;
  environmentId: EnvironmentId;
  children: (bag: SortableThreadRowBag) => ReactNode;
}) {
  const canOperateThread = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
    disabled: { draggable: props.disabled || !canOperateThread },
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  // dnd-kit memoizes each field but not the bag, so the memoized row would
  // rerender on every shell update without this.
  const bag = useMemo(
    () => ({
      listeners,
      setNodeRef,
      transform: props.contextDrag ? null : transform,
      // The lifted row normally follows the pointer without a transition.
      // When it becomes a context ghost, glide its sidebar copy back home.
      transition: props.contextDrag && isDragging ? "transform 150ms ease-out" : transition,
      isDragging: isDragging && !props.contextDrag,
    }),
    [listeners, setNodeRef, transform, transition, isDragging, props.contextDrag],
  );
  return props.children(bag);
}

// Unsent work shares one look: the new-thread draft rows and thread rows
// with unsent composer text both use this tint and pen so they read alike.
const draftSurfaceClassName = "bg-warning/4 hover:bg-warning/8";
const draftPenClassName = "size-3 shrink-0 text-warning-foreground";

// Structural list items — the section headers and the
// empty-section placeholders — take part in the sortable list so they shift
// with the rows and the gap can open on either side of them. They can't be
// picked up, and a marker is the sortable `over` when the pointer is on it,
// which resolveSidebarDropTarget turns into the section the gap sits in.
function SortableSidebarMarker(props: {
  marker: SidebarListMarker;
  className?: string;
  children?: ReactNode;
  "data-testid"?: string;
}) {
  const { setNodeRef, transform, transition } = useSortable({
    id: sidebarMarkerId(props.marker),
    disabled: { draggable: true },
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  return (
    <li
      ref={setNodeRef}
      data-thread-selection-safe
      data-testid={props["data-testid"]}
      className={cn("list-none", props.className)}
      style={{
        transform: CSS.Translate.toString(transform),
        // A newly revealed target must not slide from its hidden position.
        transition: props.marker.endsWith("-placeholder") ? "none" : transition,
        visibility: transform?.scaleY === 0 ? "hidden" : undefined,
      }}
    >
      {props.children}
    </li>
  );
}

// Empty targets stay measurable without reserving space at rest. The sorting
// strategy opens their hint space during a drag.
function SidebarSectionPlaceholder(props: {
  marker: "active-placeholder" | "settled-placeholder";
  label: string;
  showHint: boolean;
  isDropTarget: boolean;
}) {
  return (
    <SortableSidebarMarker
      marker={props.marker}
      data-testid={`sidebar-${props.marker}`}
      className="relative mx-0.5 -mb-px h-0"
    >
      {props.showHint ? (
        <div
          className={cn(
            "absolute inset-x-0 top-0 flex h-9 items-center justify-center rounded-md border border-dashed border-sidebar-foreground/25 text-xs text-sidebar-foreground/80",
            props.isDropTarget && "border-primary/40 bg-primary/5 text-primary",
          )}
        >
          {props.label}
        </div>
      ) : null}
    </SortableSidebarMarker>
  );
}

// Pointer travel before a press on a row starts a drag, or a press on its
// action button starts a sweep. Shorter presses stay clicks.
const SIDEBAR_DRAG_DISTANCE = 6;
/** The chat tab this device has open in the sidebar ("" for All). */
const CHAT_TAB_SELECTION_KEY = "t3code:sidebar-chat-tab:v1";

type SidebarSweepAction = "settle" | "unsettle" | "unsnooze";

// Zero-height markers reserve no label space at rest. During a drag the
// sorting strategy opens 24px for a 16px label with 4px clearance on each side.
const SIDEBAR_DRAG_LABEL_HEIGHT = 24;

function SidebarDragBoundary(props: {
  marker: "pinned-header" | "pinned-divider";
  label: string;
  visible: boolean;
  isDropTarget: boolean;
}) {
  return (
    <SortableSidebarMarker
      marker={props.marker}
      data-testid={`sidebar-${props.marker}`}
      className="pointer-events-none relative mx-0.5 -mb-px h-0"
    >
      {props.visible ? (
        <div className="sidebar-drag-boundary-label absolute inset-x-2 top-1 flex h-4 items-center gap-2">
          <span
            className={cn(
              "shrink-0 text-xs font-medium",
              props.isDropTarget ? "text-primary" : "text-sidebar-foreground/80",
            )}
          >
            {props.label}
          </span>
          <span
            aria-hidden
            className={cn(
              "h-px flex-1",
              props.isDropTarget ? "bg-primary/50" : "bg-sidebar-foreground/25",
            )}
          />
        </div>
      ) : null}
    </SortableSidebarMarker>
  );
}

// Shelf headers stay visible and keep their measured height while dragging.
function SidebarSectionHeader(props: {
  marker: "working-header" | "snoozed-header" | "settled-header";
  label: string;
  /** A muted trailing count; the classic look shows it only while the shelf is collapsed. */
  count: number;
  className?: string;
  // While dragging, the settled header reads at full strength and takes the
  // accent while the lifted row is over it.
  dragging?: boolean;
  isDropTarget?: boolean;
  toggle: { expanded: boolean; onToggle: () => void };
}) {
  const shelf =
    props.marker === "working-header"
      ? "working"
      : props.marker === "snoozed-header"
        ? "snoozed"
        : "settled";
  const snoozed = shelf === "snoozed";
  const redesign = useClientSettings((settings) => settings.redesignEnabled);
  const count = redesign || !props.toggle.expanded ? props.count : null;
  return (
    <SortableSidebarMarker
      marker={props.marker}
      data-testid={`sidebar-${props.marker}`}
      className={cn("mx-0.5 h-8", props.className)}
    >
      <CollapsibleSectionHeader
        onClick={props.toggle.onToggle}
        expanded={props.toggle.expanded}
        tone={
          props.isDropTarget ? "accent" : props.dragging ? "emphasized" : snoozed ? "info" : "muted"
        }
        data-testid={`sidebar-${shelf}-shelf-toggle`}
        accessory={
          count !== null ? <span className="font-normal tabular-nums">{count}</span> : null
        }
      >
        {props.label}
      </CollapsibleSectionHeader>
    </SortableSidebarMarker>
  );
}

// One unsent draft session the user has invested content in. Two lines,
// nothing else: project name, then the typed prompt. All the draft's
// settings (model, env mode, branch, worktree) still travel with it —
// clicking is a plain navigation to /draft/$draftId, which touches nothing.
// While the draft is open the row renders a frozen snapshot (see
// SidebarDraftBlock); memoized so per-keystroke block re-renders skip it
// entirely.
const SidebarDraftRow = memo(function SidebarDraftRow(props: {
  draftId: DraftId;
  composer: ComposerThreadDraftState;
  project: ProjectFaviconProject | null;
  projectDisplayName: string | null;
  isActive: boolean;
  onNavigate: (draftId: DraftId) => void;
  onDiscard: (draftId: DraftId) => void;
  onContextMenu: (draftId: DraftId, position: { x: number; y: number }) => void;
}) {
  const { composer, draftId, onContextMenu, onDiscard, onNavigate } = props;
  const privateLabel = usePrivacyLabel();
  const promptPreview =
    replaceComposerContextReferences(composer.prompt, (occurrence) => occurrence.label)
      .trim()
      .split("\n", 1)[0] ?? "";
  // images mirrors persistedAttachments once rehydration finishes; before
  // that only the persisted list is populated, hence max not sum.
  const attachmentCount =
    Math.max(composer.images.length, composer.persistedAttachments.length) +
    composer.files.length +
    composer.terminalContexts.length +
    composer.previewAnnotations.length +
    composer.reviewComments.length;
  const preview = privateLabel(
    "Chat",
    draftId,
    promptPreview.length > 0
      ? promptPreview
      : `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`,
  );
  const accessibility = resolveSidebarRowAccessibility({
    title: preview,
    statusLabel: "Unsent draft",
    projectDisplayName: props.projectDisplayName,
    isActive: props.isActive,
  });
  const handleActivate = useCallback(() => onNavigate(draftId), [draftId, onNavigate]);
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      // Keys targeting the nested discard button belong to the button:
      // preventDefault here would swallow Space's synthesized click and
      // navigate instead of discarding.
      if ((event.target as HTMLElement).closest("button")) return;
      if (
        !event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        focusSidebarRow(event.key, event.currentTarget)
      ) {
        event.preventDefault();
        return;
      }
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        onContextMenu(draftId, { x: rect.left, y: rect.bottom });
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (shouldActivateSidebarRow(event)) onNavigate(draftId);
      }
    },
    [draftId, onContextMenu, onNavigate],
  );
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      onContextMenu(draftId, { x: event.clientX, y: event.clientY });
    },
    [draftId, onContextMenu],
  );
  const handleDiscard = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onDiscard(draftId);
    },
    [draftId, onDiscard],
  );
  return (
    <li className="list-none py-0.5">
      <div
        role="button"
        tabIndex={0}
        aria-label={accessibility.label}
        aria-current={accessibility.current}
        data-testid="sidebar-draft-row"
        data-sidebar-thread-row
        className={cn(
          "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left text-sidebar-foreground outline-none select-none transition-[background-color,color,scale] duration-100 ease-out motion-reduce:transition-none active:scale-[0.99] motion-reduce:active:scale-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.isActive ? "bg-sidebar-row-active" : draftSurfaceClassName,
        )}
        onClick={handleActivate}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
      >
        <span className="sr-only">{preview}</span>
        <div className="relative z-10 h-[3.375rem] px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)">
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            <SquarePenIcon aria-hidden className={draftPenClassName} />
            <span aria-hidden className="min-w-0 flex-1 truncate text-sm text-foreground">
              {preview}
            </span>
            <span className="ml-auto flex h-5 min-w-5 shrink-0 items-center justify-end">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Discard draft"
                      onClick={handleDiscard}
                      className="pointer-events-none inline-flex cursor-pointer items-center rounded-md bg-transparent px-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100"
                    >
                      <XIcon className="size-3" />
                    </button>
                  }
                />
                <TooltipPopup side="top">Discard draft</TooltipPopup>
              </Tooltip>
            </span>
          </div>
          <div aria-hidden className="mt-0.5 truncate text-xs text-secondary-label">
            Unsent draft
          </div>
        </div>
      </div>
    </li>
  );
});

interface SidebarDraftRowData {
  draftId: DraftId;
  session: DraftSessionState;
  composer: ComposerThreadDraftState;
}

// Draft sessions with user content, surfaced above the pinned block so an
// interrupted "new thread" stays one click away. Self-contained (own store
// subscription + closing divider) so per-keystroke composer updates
// re-render only this block, never the whole sidebar. Vanishes at count 0.
const SidebarDraftBlock = memo(function SidebarDraftBlock(props: {
  projectByKey: ReadonlyMap<string, EnvironmentProject>;
  projectDisplayNameByKey: ReadonlyMap<string, string>;
  routeDraftId: string | null;
  onNavigateToDraft: (draftId: DraftId) => void;
  onDraftContextMenu: (draftId: DraftId, position: { x: number; y: number }) => void;
}) {
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftsByThreadKey = useComposerDraftStore(
    useShallow((store) =>
      Object.fromEntries(
        Object.keys(store.draftThreadsByThreadKey).map(
          (key) => [key, store.draftsByThreadKey[key]] as const,
        ),
      ),
    ),
  );
  // The open draft's row is FROZEN at the moment the draft became the route:
  // it stays visible (like a thread row) but never repaints while the user
  // types. A draft that was never navigated away from has no snapshot to
  // freeze, so a fresh typing session shows no row at all. Captured
  // synchronously on route change (setState-during-render derived state) so
  // the row never flickers out for a frame between route change and capture.
  const [frozenActive, setFrozenActive] = useState<{
    routeDraftId: string | null;
    row: SidebarDraftRowData | null;
  }>({ routeDraftId: null, row: null });
  if (frozenActive.routeDraftId !== props.routeDraftId) {
    let row: SidebarDraftRowData | null = null;
    if (props.routeDraftId !== null) {
      const draftId = DraftId.make(props.routeDraftId);
      const store = useComposerDraftStore.getState();
      const session = store.getDraftSession(draftId);
      const composer = store.getComposerDraft(draftId);
      row =
        session && session.promotedTo == null && composer && composerDraftHasUserContent(composer)
          ? { draftId, session, composer }
          : null;
    }
    setFrozenActive({ routeDraftId: props.routeDraftId, row });
  }
  const drafts = useMemo(() => {
    const rows: SidebarDraftRowData[] = [];
    // Every non-promoted session with content gets a row, mapped or not:
    // new-thread surfaces mint fresh drafts and leave invested ones behind
    // unmapped, so the mapping only knows about the latest per project.
    for (const [draftKey, session] of Object.entries(draftThreadsByThreadKey)) {
      if (session.promotedTo != null) {
        continue;
      }
      if (draftKey === props.routeDraftId) {
        // Open draft: render the frozen entry snapshot, or nothing for a
        // draft that has never been left. Gated on the LIVE session above so
        // send/discard still removes the row immediately.
        if (frozenActive.routeDraftId === draftKey && frozenActive.row !== null) {
          rows.push(frozenActive.row);
        }
        continue;
      }
      const composer = draftsByThreadKey[draftKey];
      if (!composer || !composerDraftHasUserContent(composer)) {
        continue;
      }
      rows.push({ draftId: DraftId.make(draftKey), session, composer });
    }
    rows.sort((left, right) => right.session.createdAt.localeCompare(left.session.createdAt));
    return rows;
  }, [draftThreadsByThreadKey, draftsByThreadKey, frozenActive, props.routeDraftId]);
  if (drafts.length === 0) {
    return null;
  }
  return (
    <>
      {drafts.map(({ composer, draftId, session }) => {
        const projectKey = `${session.environmentId}:${session.projectId}`;
        return (
          <SidebarDraftRow
            key={draftId}
            draftId={draftId}
            composer={composer}
            project={props.projectByKey.get(projectKey) ?? null}
            projectDisplayName={props.projectDisplayNameByKey.get(projectKey) ?? null}
            isActive={draftId === props.routeDraftId}
            onNavigate={props.onNavigateToDraft}
            // The /draft/$draftId route redirects home on its own when the
            // draft it renders disappears, so discarding the open draft needs
            // no special-casing here.
            onDiscard={discardComposerDraft}
            onContextMenu={props.onDraftContextMenu}
          />
        );
      })}
      <li
        aria-hidden
        data-testid="sidebar-draft-divider"
        className="mx-2.5 my-1.5 h-px list-none bg-sidebar-border/60"
      />
    </>
  );
});

// Verb and icon on the lifted row while it hovers over another section. Uses
// the same icons as the row actions and context menu so the drop reads as the
// action it performs.
const dropVerbBadge: Record<SidebarDropVerb, ReactNode> = {
  pin: (
    <>
      <PinIcon aria-hidden className="size-3" />
      Pin
    </>
  ),
  unpin: (
    <>
      <PinOffIcon aria-hidden className="size-3" />
      Unpin
    </>
  ),
  settle: (
    <>
      <CircleCheckIcon aria-hidden className="size-3" />
      Settle
    </>
  ),
  unsettle: (
    <>
      <Undo2Icon aria-hidden className="size-3" />
      Un-settle
    </>
  ),
  wake: (
    <>
      <AlarmClockOffIcon aria-hidden className="size-3" />
      Wake
    </>
  ),
};

const SidebarThreadRow = memo(function SidebarThreadRow(props: {
  thread: SidebarThreadSummary;
  /** What an idle chat has out ("Waiting on 2 monitors", "Next run 5:00 AM"), under its title. */
  waitingStatus?: string | null;
  prefetch: SidebarPrefetch;
  threadPrefetch: SidebarThreadPrefetch;
  variant: "card" | "slim" | "box" | "discord";
  // The session box to draw in the box layout (ranked and labeled by the list).
  box?: SessionBoxPresentation | undefined;
  // The chat's painting for the start of a list row.
  paint?: SessionBoxPresentation | undefined;
  // Settled rows un-settle, snoozed rows wake, and cards settle.
  variantAction: SidebarSweepAction;
  // False on environments whose server predates thread.settle/unsettle:
  // the lifecycle affordances hide entirely rather than fail on click.
  settlementSupported: boolean;
  // Same contract for thread.snooze/unsnooze.
  snoozeSupported: boolean;
  // Renders the pin glyph. Pinned cards keep the full settle/snooze quick
  // actions: settling clears the pin server-side, and snoozing hides the
  // card until wake with the pin intact underneath. The glyph is also the
  // in-row pin state cue (the pinned block has no header), so it always
  // shows while pinned; it only becomes a clickable unpin quick-action once
  // the pinning capability is confirmed, and stays a passive marker while
  // the descriptor is not loaded. Pinning itself lives in the context menu.
  pinningSupported: boolean;
  isPinned: boolean;
  isPending: boolean;
  // Present on rows whose server supports every drop outcome: dnd-kit
  // sortable bag applied to the row root so the whole row drags (the
  // pointer sensor's distance constraint keeps plain clicks working).
  sortable?: SortableThreadRowBag | undefined;
  dropVerb: SidebarDropVerb | null;
  // While dragging, the pin marker stays only for a pinned thread still over
  // the pinned section. Any other position shows the verb badge instead, and
  // the badge carries its own icon.
  dragOverPinned: boolean;
  // The action this row will take when the sweep is released.
  sweepAction: SidebarSweepAction | null;
  // Compact wake countdown ("2h") for rows in the snoozed shelf.
  snoozeWakeLabelText: string | null;
  // When a snooze ended (timer or early wake); drives the Woke pill until
  // the user visits the thread.
  wokeAt: string | null;
  isActive: boolean;
  // Read at click time; a prop would re-render every row on entering or leaving a thread route.
  readOpensPullRequestsInRightPanel: () => boolean;
  jumpLabel: string | null;
  currentEnvironmentId: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  scratchMachineLabel: string | null;
  project: EnvironmentProject | null;
  projectDisplayName: string | null;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
  timestampFormat: TimestampFormat;
  onThreadClick: (event: ReactMouseEvent, threadRef: ScopedThreadRef) => void;
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
  onStartRename: (threadRef: ScopedThreadRef, title: string) => void;
  onRenameTitleChange: (title: string) => void;
  onCommitRename: (threadRef: ScopedThreadRef, title: string, originalTitle: string) => void;
  onCancelRename: () => void;
  isRenaming: boolean;
  renamingTitle: string;
  onContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
  onSettle: (threadRef: ScopedThreadRef) => void;
  onActionSweepStart: (
    threadRef: ScopedThreadRef,
    action: SidebarSweepAction,
    event: PointerEvent,
  ) => void;
  onUnsettle: (threadRef: ScopedThreadRef) => void;
  onSnooze: (threadRef: ScopedThreadRef, preset: Pick<SnoozePreset, "snoozedUntil">) => void;
  onUnsnooze: (threadRef: ScopedThreadRef) => void;
  onUnpin: (threadRef: ScopedThreadRef) => void;
  onAcknowledgeWoke: (threadRef: ScopedThreadRef, visitedAt: string) => void;
  onFileDropThreads?: ((threadRef: ScopedThreadRef, files: File[]) => void) | undefined;
  changeRequestSnapshot: ThreadChangeRequestSnapshot | null;
  onChangeRequestSnapshot: (
    threadKey: string,
    snapshot: ThreadChangeRequestSnapshot | null,
  ) => void;
}) {
  const {
    isRenaming,
    changeRequestSnapshot,
    onChangeRequestSnapshot,
    onCancelRename,
    onCommitRename,
    onContextMenu,
    onAcknowledgeWoke,
    onFileDropThreads,
    onRenameTitleChange,
    onSettle,
    onActionSweepStart,
    onSnooze,
    onStartRename,
    onThreadActivate,
    onThreadClick,
    onUnsettle,
    onUnsnooze,
    onUnpin,
    readOpensPullRequestsInRightPanel,
    renamingTitle,
    thread,
    variant,
    variantAction,
  } = props;
  const privateLabel = usePrivacyLabel();
  const privacy = usePrivacyMode();
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const threadKey = scopedThreadKey(threadRef);
  const prefetchIntent = useSidebarPrefetchIntent(
    threadKey,
    props.prefetch,
    props.threadPrefetch,
    sidebarPrefetchRevision(thread),
    props.isActive,
  );
  const canOperateThread =
    useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope) && !props.isPending;
  useEffect(() => {
    if ((!canOperateThread || privacy) && isRenaming) onCancelRename();
  }, [canOperateThread, privacy, isRenaming, onCancelRename]);
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(props.isActive);
  const isRegeneratingTitle = thread.titleRegeneration != null;
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const openPrLink = useOpenPrLink();
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const terminalProcessCount = runningTerminalIds.length;
  // Unsent composer text on this thread. The open thread shows its own
  // composer, so the marker only decorates rows you have navigated away from.
  const hasUnsentDraft = useThreadHasUnsentDraft(threadRef) && !props.isActive;
  const handleDiscardDraftClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      discardComposerDraft(threadRef);
    },
    [threadRef],
  );

  const gitCwd = thread.worktreePath ?? props.project?.workspaceRoot ?? null;
  const linkedPullRequestStatus = useLinkedThreadPullRequest(
    thread.environmentId,
    thread.linkedPullRequest,
    leaseLiveStatus,
    thread.pullRequests,
    thread.branchPullRequest,
  );
  const gitStatus = useEnvironmentQuery(
    leaseLiveStatus && (thread.branch != null || thread.worktreePath !== null) && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd, includeRemote: false },
        })
      : null,
  );
  const visibleGitStatus = useRetainedValue(
    JSON.stringify([thread.environmentId, gitCwd]),
    gitStatus.data,
  );
  const checkoutThread = withoutRemovedCheckout(thread, visibleGitStatus);
  const pr = linkedPullRequestStatus?.pr ?? null;
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(thread.environmentId);
  const currentLinkedPr = supportsMultiplePullRequests
    ? resolveThreadCurrentPullRequestLink(thread.pullRequests)
    : null;

  // Same semantics as the legacy sidebar (never-visited counts as read):
  // switching sidebars must not light up every historical thread as unread.
  const isUnread =
    (variant !== "discord" || !props.isActive) &&
    sidebarThreadIsUnread(thread, localLastVisitedAt, variant === "discord");
  const rawStatus = resolveSidebarThreadStatus(thread);
  const connection = useAtomValue(environmentPresentations.presentationAtom(thread.environmentId));
  const status = resolveSidebarDisplayStatus(rawStatus, connection?.connection.phase);
  const connectionStatus =
    status === "connecting" || status === "reconnecting" || status === "offline" ? status : null;
  // A turn that is still open but has shown nothing for a long while: possibly stuck, possibly a
  // slow silent step. The label says only what is known.
  const lastActivityAt = status === "working" ? resolveLastActivityAt(thread) : null;
  const isQuiet = useQuietTurn(lastActivityAt);
  const box =
    props.box === undefined
      ? undefined
      : sessionBoxConnectionPresentation(props.box, connection?.connection.phase);
  const paint =
    props.paint === undefined
      ? undefined
      : sessionBoxConnectionPresentation(props.paint, connection?.connection.phase);
  const isInFlight =
    rawStatus === "working" ||
    rawStatus === "waiting" ||
    rawStatus === "approval" ||
    rawStatus === "input";
  // A woken thread reappears at its original position (the sort is
  // deliberately static), so the pill has to carry the weight. Snoozing is
  // an explicit act, so the pill clears only when the user re-engages:
  // reading a completion-triggered wake, clicking the pill, sending a
  // message, settling, archiving, or a change request state that settles the
  // thread. Timer wakes survive a mere visit. An unparseable visit timestamp
  // counts as never-visited, so corrupt local data cannot eat the wake signal.
  const lastVisitedDate = lastVisitedAt === undefined ? null : parseTimestampDate(lastVisitedAt);
  const wokeAtDate = props.wokeAt === null ? null : parseTimestampDate(props.wokeAt);
  const isWoke =
    wokeAtDate !== null &&
    (lastVisitedDate === null || lastVisitedDate < wokeAtDate) &&
    thread.settledOverride !== "settled";
  // Color asks for attention. A failure the user has already opened keeps its
  // label but goes quiet, like it does in the Needs you count.
  const nowMs = useNowMinuteMs();
  const failureSeen =
    (status === "failed" || status === "limited") &&
    !failureNeedsYou({ ...thread, lastVisitedAt }, nowMs);
  // Status hues follow the system-wide convention set by sidebar v1 and the
  // mobile Live Activity/widgets (amber approval, indigo input, sky working)
  // so a thread reads the same color everywhere it surfaces.
  const topStatus =
    connectionStatus !== null
      ? {
          label: connectionWorkLabel(connectionStatus),
          icon: "waiting" as const,
          className: "text-muted-foreground",
        }
      : status === "working"
        ? isQuiet
          ? {
              // Grey, not a warning: quiet is a fact, stuck would be a guess.
              label: "Quiet",
              icon: "waiting" as const,
              className: "text-muted-foreground",
            }
          : {
              // A native /goal keeps the agent going across turns until it is met.
              label: thread.goal?.status === "active" ? "Goal" : "Working",
              icon: "working" as const,
              // No shimmer: a label that animates forever is noise in a sidebar
              // full of them (and repaints every vsync on high-refresh displays).
              className: "text-info-foreground",
            }
        : status === "waiting"
          ? {
              // Waiting is calm background presence (post-settle background
              // roster), not active progress, so the label keeps full strength.
              label: "Waiting",
              icon: "waiting" as const,
              className: "text-muted-foreground",
            }
          : status === "approval"
            ? {
                label: "Approval",
                icon: "approval" as const,
                className: "text-warning-foreground",
              }
            : status === "input"
              ? {
                  // The same words as the filter above, the phone and the menu bar.
                  label: "Needs you",
                  icon: "input" as const,
                  className: "text-indigo-600 dark:text-indigo-300",
                }
              : status === "limited"
                ? {
                    label: "Limited",
                    icon: "failed" as const,
                    className: failureSeen ? "text-muted-foreground" : "text-warning-foreground",
                  }
                : status === "failed"
                  ? {
                      label: "Failed",
                      icon: "failed" as const,
                      className: failureSeen ? "text-muted-foreground" : "text-error-foreground",
                    }
                  : isWoke
                    ? {
                        label: "Woke",
                        icon: "woke" as const,
                        className: "text-warning-foreground",
                      }
                    : null;
  const isWokeStatus = topStatus?.icon === "woke";

  const branchMismatch = resolveLocalCheckoutBranchMismatch({
    effectiveEnvMode: thread.worktreePath === null ? "local" : "worktree",
    activeWorktreePath: thread.worktreePath,
    activeThreadBranch: thread.branch,
    currentGitBranch: visibleGitStatus?.refName ?? null,
  });
  const prStatus = prStatusIndicator(pr, linkedPullRequestStatus?.sourceControlProvider);

  const modelInstanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const providerEntry = props.providerEntryByInstanceId.get(modelInstanceId) ?? null;
  const showInstanceBadge =
    providerEntry !== null &&
    shouldShowInstanceBadge(providerEntry, props.providerEntryByInstanceId.values());
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelLabel(selectedModel)
    : thread.modelSelection.model;

  // The local environment is "this machine" and needs no marker; every other
  // one gets its machine glyph. With no local environment (the hosted app)
  // that is every thread, which is the point: the glyph is what tells rows on
  // different machines apart.
  const isRemote = thread.environmentId !== props.currentEnvironmentId;
  const shownBranch = checkoutThread.branch;
  const showsScratchMachine = !shownBranch && props.scratchMachineLabel !== null;

  const detailsTooltip = (
    <SidebarThreadTooltip
      thread={checkoutThread}
      prefetch={props.prefetch}
      project={props.project}
      projectDisplayName={props.projectDisplayName}
      environmentLabel={props.environmentLabel}
      environmentMachine={props.environmentMachine}
      providerEntry={providerEntry}
      providerEntryByInstanceId={props.providerEntryByInstanceId}
      showInstanceBadge={showInstanceBadge}
      modelInstanceId={modelInstanceId}
      modelLabel={modelLabel}
      branchMismatch={branchMismatch}
      terminalStatus={terminalStatus}
      terminalProcessCount={terminalProcessCount}
    />
  );

  const handleClick = useCallback(
    (event: ReactMouseEvent) => {
      onThreadClick(event, threadRef);
    },
    [onThreadClick, threadRef],
  );
  const handleAcknowledgeWokeClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (props.wokeAt === null) return;
      onAcknowledgeWoke(threadRef, props.wokeAt);
    },
    [onAcknowledgeWoke, props.wokeAt, threadRef],
  );
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      onContextMenu(threadRef, { x: event.clientX, y: event.clientY });
    },
    [onContextMenu, threadRef],
  );
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (
        !event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        focusSidebarRow(event.key, event.currentTarget)
      ) {
        event.preventDefault();
        return;
      }
      if (
        event.key === "F2" &&
        !event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        canOperateThread
      ) {
        event.preventDefault();
        onStartRename(threadRef, thread.title);
        return;
      }
      // The keyboard's way to the row menu (rename, pin, archive), as on draft rows.
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        onContextMenu(threadRef, { x: rect.left, y: rect.bottom });
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (!shouldActivateSidebarRow(event)) return;
      onThreadActivate(threadRef);
    },
    [canOperateThread, onContextMenu, onStartRename, onThreadActivate, thread.title, threadRef],
  );
  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent) => {
      if (
        !readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope) ||
        isRenaming ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      if ((event.target as HTMLElement).closest("button, a, input")) return;
      event.preventDefault();
      onStartRename(threadRef, thread.title);
    },
    [isRenaming, onStartRename, thread.title, threadRef],
  );
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const fileDropHandlers = useMemo(
    () =>
      onFileDropThreads
        ? makeWorkspaceFileDropHandlers({
            setDragActive: setIsFileDragOver,
            addFiles: (files) => {
              onFileDropThreads(threadRef, files);
            },
            addFolders: () => {},
          })
        : null,
    [onFileDropThreads, threadRef],
  );
  useEffect(() => {
    if (!isFileDragOver) return;
    const clearFileDrag = () => setIsFileDragOver(false);
    window.addEventListener("dragend", clearFileDrag);
    return () => window.removeEventListener("dragend", clearFileDrag);
  }, [isFileDragOver]);
  const renameCommittedRef = useRef(false);
  useEffect(() => {
    if (isRenaming) renameCommittedRef.current = false;
  }, [isRenaming]);
  const handleRenameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") {
        event.preventDefault();
        renameCommittedRef.current = true;
        onCommitRename(threadRef, renamingTitle, thread.title);
        event.currentTarget
          .closest<HTMLElement>("[data-sidebar-thread-row]")
          ?.focus({ preventScroll: true });
      } else if (event.key === "Escape") {
        event.preventDefault();
        renameCommittedRef.current = true;
        onCancelRename();
        event.currentTarget
          .closest<HTMLElement>("[data-sidebar-thread-row]")
          ?.focus({ preventScroll: true });
      }
    },
    [onCancelRename, onCommitRename, renamingTitle, thread.title, threadRef],
  );
  const handleRenameBlur = useCallback(() => {
    if (!renameCommittedRef.current) {
      renameCommittedRef.current = true;
      onCommitRename(threadRef, renamingTitle, thread.title);
    }
  }, [onCommitRename, renamingTitle, thread.title, threadRef]);
  const handleSettleClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onSettle(threadRef);
    },
    [onSettle, threadRef],
  );
  const handleActionPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      if (!event.isPrimary || event.button !== 0) return;
      // Action buttons sweep their section rather than picking up the row.
      event.stopPropagation();
      onActionSweepStart(threadRef, variantAction, event.nativeEvent);
    },
    [onActionSweepStart, threadRef, variantAction],
  );
  const handleUnsettleClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onUnsettle(threadRef);
    },
    [onUnsettle, threadRef],
  );
  const handleUnsnoozeClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onUnsnooze(threadRef);
    },
    [onUnsnooze, threadRef],
  );
  const handleUnpinClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onUnpin(threadRef);
    },
    [onUnpin, threadRef],
  );
  const handleSnoozePreset = useCallback(
    (preset: Pick<SnoozePreset, "snoozedUntil">) => {
      onSnooze(threadRef, preset);
    },
    [onSnooze, threadRef],
  );
  // While the snooze popover is open the pointer leaves the row, which
  // would fade the hover actions out from under the open menu. Pin them and
  // suppress the row tooltip so its portal cannot overlap the popover.
  const [snoozeMenuOpenRaw, setSnoozeMenuOpen] = useState(false);
  // Snooze is offered only where it can succeed: capability-gated and never
  // on blocked-on-you work or queued turns (the server rejects both).
  const showSnoozeButton =
    canOperateThread &&
    props.snoozeSupported &&
    canSnooze(thread, { now: new Date().toISOString() });
  const showHoverActions =
    (canOperateThread && props.settlementSupported) || showSnoozeButton || hasUnsentDraft;
  // The card row draws its action slot whenever one of these may appear in it.
  const hasRowActions = props.settlementSupported || showSnoozeButton || hasUnsentDraft;
  // If the thread becomes blocked while the popover is open, the button
  // unmounts without firing onOpenChange(false). Deriving the flag keeps a
  // stale true from permanently hiding the status label / pinning the
  // hover actions, and the effect clears the raw state so the popover
  // doesn't resurrect if the button later remounts.
  const snoozeMenuOpen = snoozeMenuOpenRaw && showSnoozeButton;
  useEffect(() => {
    if (!showSnoozeButton) setSnoozeMenuOpen(false);
  }, [showSnoozeButton]);
  const handlePrClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>, targetUrl?: string) => {
      const url = targetUrl ?? pr?.url ?? currentLinkedPr?.url;
      if (!url) return;
      const showInRightPanel = targetUrl !== undefined || readOpensPullRequestsInRightPanel();
      const openedInRightPanel = openPrLink(event, url, showInRightPanel ? threadRef : undefined);
      if (openedInRightPanel && showInRightPanel && !props.isActive) {
        onThreadActivate(threadRef);
      }
    },
    [
      onThreadActivate,
      openPrLink,
      readOpensPullRequestsInRightPanel,
      pr,
      currentLinkedPr,
      props.isActive,
      threadRef,
    ],
  );

  // All sidebar rows share one surface model. Live threads used to look
  // like elevated cards while settled threads were plain rows, leaving neither
  // a useful hierarchy nor a reliable hover cue. Status now lives in the row
  // content; surface is reserved for interaction (hover, multi-select, route).
  const rowSurfaceClassName = cn(
    "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none transition-[background-color,color,scale] duration-100 ease-out motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    props.isActive
      ? "bg-sidebar-row-active text-sidebar-foreground"
      : isSelected || props.sweepAction !== null
        ? "bg-sidebar-row-selected text-sidebar-foreground"
        : hasUnsentDraft
          ? cn(draftSurfaceClassName, "text-sidebar-foreground")
          : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover active:bg-sidebar-row-active",
    !props.sortable?.isDragging && "active:scale-[0.99] motion-reduce:active:scale-100",
    isFileDragOver && "ring-1 ring-inset ring-primary/70",
    isFileDragOver && !props.isActive && !isSelected && "bg-sidebar-row-hover",
    // The lifted row is an opaque card so the rows beneath it never show
    // through. The row tint is translucent in dark themes and the pointer
    // keeps the hover color applied, so both the tint and the solid sidebar
    // color are stacked as background images.
    props.sortable?.isDragging &&
      "bg-sidebar bg-linear-to-b from-sidebar-row-active to-sidebar-row-active text-sidebar-foreground opacity-100 shadow-lg",
  );
  // dnd-kit props for the row root. Same bag on both variants: every row in
  // the list translates around the gap as the drag passes it.
  const sortable = props.sortable;
  const sortableRootProps = sortable
    ? {
        ref: sortable.setNodeRef,
        style: {
          transform: CSS.Translate.toString(sortable.transform),
          transition: sortable.transition,
          // A zero-height boundary also makes dnd-kit scale the source to
          // zero. Only projected peers use scaleY as a visibility sentinel.
          visibility:
            !sortable.isDragging && sortable.transform?.scaleY === 0
              ? ("hidden" as const)
              : undefined,
        },
        ...sortable.listeners,
      }
    : {};
  // Sweeps reuse the corresponding row-drop action badge.
  const destinationVerb = sortable?.isDragging
    ? props.dropVerb
    : props.sweepAction === "unsnooze"
      ? "wake"
      : props.sweepAction;
  const dragDestination =
    destinationVerb !== null ? (
      <span
        role="status"
        className="pointer-events-none ml-auto inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-1.5 text-2xs font-medium text-primary"
      >
        {dropVerbBadge[destinationVerb]}
      </span>
    ) : null;

  const accessibility = resolveSidebarRowAccessibility({
    title: privateLabel("Chat", thread.id, thread.title),
    // The row's label replaces its contents for screen readers, so the
    // unread dot's own "Unread" label is never read; carry it here.
    statusLabel: topStatus?.label ?? (isUnread ? "Unread" : null),
    projectDisplayName: props.projectDisplayName,
    isActive: props.isActive,
  });

  const prBadgeShape = supportsMultiplePullRequests
    ? resolveThreadPullRequestBadge(thread.pullRequests)
    : null;
  const diff = latestRunDiff(thread);
  // A painted card with nothing under its title (no branch, machine, PR or diff) gives the
  // title both lines, so look-alike chats read apart instead of cutting off after a word.
  // What an idle chat has out ("1 subagent running", "Waiting on 2 monitors",
  // "Next run Tue 5:00 AM") crowded the status slot, so it gets the line under the title.
  const waitingLine =
    (status === "waiting"
      ? presentBackgroundWaitInThreadRow(thread.pendingBackgroundTasks)
      : null) ??
    props.waitingStatus ??
    null;
  const wrapsTitle =
    waitingLine === null &&
    thread.source.comparison == null &&
    variant !== "slim" &&
    variant !== "discord" &&
    props.paint !== undefined &&
    !shownBranch &&
    !showsScratchMachine &&
    diff === null &&
    prBadgeShape?.kind !== "stack" &&
    !pr &&
    !currentLinkedPr;
  const title =
    isRenaming && canOperateThread && !privacy ? (
      <input
        autoFocus
        value={renamingTitle}
        aria-label="Chat title"
        onChange={(event) => onRenameTitleChange(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={handleRenameKeyDown}
        onBlur={handleRenameBlur}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        className="min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-sm font-medium text-card-foreground outline-none focus:border-foreground"
      />
    ) : (
      <span
        aria-hidden
        className={cn(
          "min-w-0 flex-1 text-sm text-foreground transition-opacity motion-reduce:transition-none",
          wrapsTitle ? "line-clamp-2 leading-4.75 break-words" : "truncate",
          // The hover actions lie over the end of the title; it fades out under them.
          hasRowActions &&
            !isWokeStatus &&
            (snoozeMenuOpen
              ? "[mask-image:linear-gradient(to_left,transparent_0.75rem,black_2.25rem)]"
              : "group-any-hover/sidebar-row:[mask-image:linear-gradient(to_left,transparent_0.75rem,black_2.25rem)] group-has-[[data-sidebar-row-actions]_:focus-visible]/sidebar-row:[mask-image:linear-gradient(to_left,transparent_0.75rem,black_2.25rem)]"),
          isRegeneratingTitle && "opacity-55",
          // New design: a chat you've read recedes until you point at it, so unread ones lead.
          !isUnread &&
            !props.isActive &&
            "redesign:text-foreground/75 redesign:group-hover/sidebar-row:text-foreground redesign:group-focus-visible/sidebar-row:text-foreground",
        )}
      >
        {privateLabel("Chat", thread.id, thread.title)}
      </span>
    );
  const comparisonBadge = thread.source.comparison ? (
    <span
      role="img"
      aria-label={`${thread.source.comparison.threadIds.length} models`}
      className="absolute -right-1 -bottom-1 flex min-w-3 items-center justify-center rounded-full bg-muted px-0.5 text-3xs leading-3 text-muted-foreground tabular-nums"
    >
      {thread.source.comparison.threadIds.length}
    </span>
  ) : null;
  const accessibleTitle = isRenaming ? null : (
    <span className="sr-only">{privateLabel("Chat", thread.id, thread.title)}</span>
  );
  const unreadDot =
    isUnread && topStatus === null ? (
      <span role="img" aria-label="Unread" className="size-1.5 shrink-0 rounded-full bg-primary" />
    ) : null;

  // Stacks show their layer count; multiple unrelated links show their total count.
  // Either opens the thread's pull requests tab; a single PR link opens that PR and still
  // supports opening the host in a new tab.
  const handlePrListClick = useCallback(() => {
    useRightPanelStore.getState().open(threadRef, "pull-requests");
    if (!props.isActive) onThreadActivate(threadRef);
  }, [onThreadActivate, props.isActive, threadRef]);
  const prBadge =
    prBadgeShape?.kind === "stack" || pr || currentLinkedPr ? (
      <ThreadPullRequestBadgeControl
        render={<InlineButton />}
        badge={prBadgeShape}
        pullRequests={thread.pullRequests}
        number={pr?.number ?? currentLinkedPr?.number}
        url={pr?.url ?? currentLinkedPr?.url}
        status={prStatus}
        onOpenList={handlePrListClick}
        onOpenPullRequest={handlePrClick}
      />
    ) : null;
  const processStatusIcons = (
    <>
      <ThreadCpuIndicator threadRef={threadRef} />
      <ThreadTerminalStatusButton
        threadRef={threadRef}
        terminalIds={runningTerminalIds}
        onThreadActivate={onThreadActivate}
      />
    </>
  );
  // Same pen the new-thread draft rows lead with, so both kinds of unsent
  // work read the same way in the list.
  const draftIndicator = hasUnsentDraft ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label="Unsent draft"
            data-testid={`sidebar-draft-indicator-${thread.id}`}
            className="inline-flex shrink-0 items-center"
          />
        }
      >
        <SquarePenIcon aria-hidden className={draftPenClassName} />
      </TooltipTrigger>
      <TooltipPopup side="top">Unsent draft</TooltipPopup>
    </Tooltip>
  ) : null;
  const showPin =
    props.isPinned && (!sortable?.isDragging || (props.dragOverPinned && props.dropVerb === null));
  const canUnpin = showPin && props.pinningSupported && canOperateThread && !sortable?.isDragging;
  // The hover actions lie over the row's right edge, which is where the pin sits: it
  // steps aside while they show, and Unpin joins them (see the actions below).
  const pinYieldsToActions = hasRowActions && !isWokeStatus;
  const pinHiddenUnderActions = !pinYieldsToActions
    ? undefined
    : snoozeMenuOpen
      ? "invisible"
      : "group-any-hover/sidebar-row:invisible group-has-[[data-sidebar-row-actions]_:focus-visible]/sidebar-row:invisible";
  const pinIndicator = showPin ? (
    canUnpin ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Unpin chat"
              onClick={handleUnpinClick}
              className={cn(
                "group/unpin inline-flex cursor-pointer items-center rounded-sm text-muted-foreground/65 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                pinHiddenUnderActions,
              )}
            />
          }
        >
          {/* Pin marks the pinned state at rest; hover and focus swap in pin-off so the
              icon reads as the action the button performs. */}
          <PinIcon
            aria-hidden
            className="size-3 shrink-0 group-hover/unpin:hidden group-focus-visible/unpin:hidden"
          />
          <PinOffIcon
            aria-hidden
            className="hidden size-3 shrink-0 group-hover/unpin:block group-focus-visible/unpin:block"
          />
        </TooltipTrigger>
        <TooltipPopup>Unpin chat</TooltipPopup>
      </Tooltip>
    ) : (
      <PinIcon
        aria-label="Pinned"
        role="img"
        className={cn("size-3 shrink-0 text-muted-foreground/65", pinHiddenUnderActions)}
      />
    )
  ) : null;

  if (variant === "box" && box) {
    return (
      <li data-thread-item={threadKey} {...(fileDropHandlers ?? {})} className="list-none">
        <Tooltip>
          <TooltipTrigger
            render={
              <div
                ref={rowRef}
                {...prefetchIntent}
                data-sidebar-thread-row
                data-sidebar-pending={props.isPending || undefined}
                role="button"
                tabIndex={0}
                aria-label={accessibility.label}
                aria-current={accessibility.current}
                data-testid="sidebar-row-box"
                aria-busy={props.isPending || undefined}
                className="group/sidebar-row relative cursor-pointer rounded-xl outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                onClick={handleClick}
                onKeyDown={handleKeyDown}
                onContextMenu={handleContextMenu}
              />
            }
          >
            {accessibleTitle}
            <SessionBox
              identity={thread.id}
              box={box}
              {...harnessMascotIdentity({
                driver: providerEntry?.driverKind ?? null,
                instanceId: modelInstanceId,
                model: thread.modelSelection.model,
                agentId: providerEntry?.acpRegistryAgentId ?? null,
              })}
              isActive={props.isActive}
              isSelected={isSelected}
              isPinned={props.isPinned}
              machineLabel={isRemote ? props.environmentLabel : null}
              accessory={draftIndicator}
            />
            {isRenaming && canOperateThread && !privacy ? (
              <div className="absolute inset-x-1 bottom-1 flex">{title}</div>
            ) : null}
            {props.jumpLabel ? (
              <span className="absolute top-1 left-1/2 -translate-x-1/2">
                <JumpHintBadge label={props.jumpLabel} />
              </span>
            ) : null}
          </TooltipTrigger>
          {detailsTooltip}
        </Tooltip>
      </li>
    );
  }

  if (variant === "discord") {
    const count = threadNeedsYouCount(thread, localLastVisitedAt);
    return (
      <li
        data-thread-item={threadKey}
        {...sortableRootProps}
        {...(fileDropHandlers ?? {})}
        className="dc-channel-item list-none [content-visibility:auto] [contain-intrinsic-size:auto_34px]"
      >
        <Tooltip disabled={sortable?.isDragging || snoozeMenuOpen}>
          <TooltipTrigger
            render={
              <div
                ref={rowRef}
                {...prefetchIntent}
                data-sidebar-thread-row
                data-sidebar-pending={props.isPending || undefined}
                role="button"
                tabIndex={0}
                aria-label={`${accessibility.label}${count ? `, ${count} need you` : ""}`}
                aria-current={accessibility.current}
                data-selected={props.isActive || isSelected}
                aria-busy={props.isPending || undefined}
                data-unread={isUnread}
                className="dc-channel-row group/sidebar-row"
                onClick={handleClick}
                onDoubleClick={handleDoubleClick}
                onKeyDown={handleKeyDown}
                onContextMenu={handleContextMenu}
              />
            }
          >
            <span className="relative shrink-0">
              <HashIcon aria-hidden className="dc-channel-hash" />
              {comparisonBadge}
            </span>
            {title}
            {connectionStatus !== null ? (
              <span className="text-xs text-muted-foreground">
                {connectionWorkLabel(connectionStatus)}
              </span>
            ) : null}
            {draftIndicator}
            {props.isPinned ? <PinIcon aria-label="Pinned" size={12} /> : null}
            {count > 0 ? (
              <span className="dc-channel-badge" aria-label={`${count} need you`}>
                {count}
              </span>
            ) : null}
            {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
            <span className="dc-channel-actions">
              {canOperateThread && props.settlementSupported ? (
                <button
                  type="button"
                  aria-label={
                    variantAction === "unsettle"
                      ? "Unsettle chat"
                      : variantAction === "unsnooze"
                        ? "Wake chat"
                        : "Settle chat"
                  }
                  onClick={
                    variantAction === "unsettle"
                      ? handleUnsettleClick
                      : variantAction === "unsnooze"
                        ? handleUnsnoozeClick
                        : handleSettleClick
                  }
                  onPointerDown={handleActionPointerDown}
                >
                  <CircleCheckIcon size={15} />
                </button>
              ) : null}
              {canOperateThread ? (
                <button
                  type="button"
                  aria-label="Rename chat"
                  onClick={(event) => {
                    event.stopPropagation();
                    onStartRename(threadRef, thread.title);
                  }}
                >
                  <SquarePenIcon size={14} />
                </button>
              ) : null}
              <button
                type="button"
                aria-label="Chat actions"
                onClick={(event) => {
                  event.stopPropagation();
                  const rect = event.currentTarget.getBoundingClientRect();
                  onContextMenu(threadRef, { x: rect.left, y: rect.bottom });
                }}
              >
                <EllipsisIcon size={16} />
              </button>
            </span>
            {sortable?.isDragging ? dragDestination : null}
          </TooltipTrigger>
          {detailsTooltip}
        </Tooltip>
      </li>
    );
  }

  if (variant === "slim") {
    return (
      <li
        data-thread-item={threadKey}
        {...sortableRootProps}
        {...(fileDropHandlers ?? {})}
        className={cn(
          // Matches the h-9 row so unrendered rows never shift the list when they paint.
          "list-none [content-visibility:auto] [contain-intrinsic-size:auto_36px]",
          sortable?.isDragging && "relative z-20",
        )}
      >
        <Tooltip disabled={sortable?.isDragging}>
          <TooltipTrigger
            render={
              <div
                ref={rowRef}
                {...prefetchIntent}
                data-sidebar-thread-row
                data-sidebar-pending={props.isPending || undefined}
                role="button"
                tabIndex={0}
                aria-label={accessibility.label}
                aria-current={accessibility.current}
                data-testid="sidebar-row-slim"
                aria-busy={isRegeneratingTitle || props.isPending || undefined}
                className={cn(rowSurfaceClassName, "flex h-9 items-center gap-2.5 px-2.5")}
                onClick={handleClick}
                onDoubleClick={handleDoubleClick}
                onKeyDown={handleKeyDown}
                onContextMenu={handleContextMenu}
              />
            }
          >
            {accessibleTitle}
            {paint || comparisonBadge ? (
              <span className="relative shrink-0">
                {paint ? (
                  <SessionBoxPainting box={paint} size={22} />
                ) : (
                  <HashIcon aria-hidden className="size-5" />
                )}
                {comparisonBadge}
              </span>
            ) : null}
            {draftIndicator}
            {unreadDot}
            {title}
            {pinIndicator}
            {processStatusIcons}
            {isRegeneratingTitle ? (
              <span role="status" className="sr-only">
                Regenerating title
              </span>
            ) : null}
            {/* The PR badge stays outside the hover-fading slot: it must
              remain visible AND clickable while the row is hovered. Only
              the time/jump label yields to the settle affordance. */}
            {prBadge}
            {sortable?.isDragging ? (
              dragDestination
            ) : (
              <span
                className={cn(
                  "relative ml-auto flex h-6 min-w-8 shrink-0 items-center justify-end",
                  props.sweepAction !== null && "hidden",
                )}
              >
                <span
                  className={cn(
                    "inline-flex justify-end tabular-nums text-secondary-label transition-opacity",
                    !isWoke && "group-any-hover/sidebar-row:opacity-0",
                  )}
                >
                  {connectionStatus !== null ? (
                    <span className="text-xs">{connectionWorkLabel(connectionStatus)}</span>
                  ) : variantAction === "unsnooze" && props.snoozeWakeLabelText !== null ? (
                    // Snoozed rows show when they come BACK, not when they were
                    // last touched — the return ticket is the row's whole story.
                    <span className="text-xs text-info-foreground tabular-nums">
                      {props.snoozeWakeLabelText}
                    </span>
                  ) : isWoke ? (
                    // A wake can land straight in the settled tail (e.g. PR
                    // merged while snoozed); the signal must survive the trip.
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            aria-label="Dismiss Woke notification"
                            onClick={handleAcknowledgeWokeClick}
                            className="inline-flex cursor-pointer items-center gap-1 rounded-sm text-xs font-medium text-warning-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                          >
                            <AlarmClockIcon aria-hidden className="size-3" />
                            <span role="status">Woke</span>
                          </button>
                        }
                      />
                      <TooltipPopup side="top">Dismiss Woke notification</TooltipPopup>
                    </Tooltip>
                  ) : (
                    <span className="text-xs">
                      {variantAction === "unsettle"
                        ? settledTimeLabel(thread, nowMs)
                        : threadTimeLabel(thread, nowMs)}
                    </span>
                  )}
                </span>
                {variantAction === "unsnooze" ? (
                  !props.snoozeSupported ? null : (
                    <button
                      type="button"
                      aria-label="Wake chat now"
                      disabled={props.isPending}
                      onClick={handleUnsnoozeClick}
                      onPointerDown={handleActionPointerDown}
                      className={cn(
                        "pointer-events-none absolute inset-y-0 right-0 -mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100",
                        isWoke && "group-any-hover/sidebar-row:static",
                      )}
                    >
                      <AlarmClockOffIcon className="mb-px size-3" />
                    </button>
                  )
                ) : !props.settlementSupported ? null : variantAction === "unsettle" ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          aria-label="Un-settle chat"
                          disabled={props.isPending}
                          onClick={handleUnsettleClick}
                          onPointerDown={handleActionPointerDown}
                          className={cn(
                            "pointer-events-none absolute inset-y-0 right-0 -mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100",
                            isWoke && "group-any-hover/sidebar-row:static",
                          )}
                        />
                      }
                    >
                      <Undo2Icon className="mb-px size-3.5" />
                    </TooltipTrigger>
                    <TooltipPopup side="top">Un-settle chat</TooltipPopup>
                  </Tooltip>
                ) : (
                  <button
                    type="button"
                    aria-label="Settle chat"
                    disabled={props.isPending}
                    onClick={handleSettleClick}
                    onPointerDown={handleActionPointerDown}
                    className={cn(
                      "pointer-events-none absolute inset-y-0 right-0 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-2 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100",
                      isWoke && "group-any-hover/sidebar-row:static",
                    )}
                  >
                    <CheckIcon className="size-3" />
                  </button>
                )}
              </span>
            )}
            {props.sweepAction !== null ? dragDestination : null}
            {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
          </TooltipTrigger>
          {detailsTooltip}
        </Tooltip>
      </li>
    );
  }

  const trailingIcons = (
    <span
      aria-hidden
      className="pointer-events-none ml-auto inline-flex shrink-0 items-center gap-1"
    >
      {isRemote && !showsScratchMachine ? (
        <span className="inline-flex shrink-0 items-center text-sidebar-muted-foreground/70">
          <EnvironmentMachineIcon
            aria-hidden
            kind={props.environmentMachine}
            className="size-3.5"
          />
        </span>
      ) : null}
      <SidebarProviderStack
        thread={thread}
        providerEntryByInstanceId={props.providerEntryByInstanceId}
      />
    </span>
  );
  // Each wrapper is `contents` unless the title wraps: then the leading marks sit on its
  // first line, and the status stacks over the icons in a column of their own.
  const firstLine = wrapsTitle
    ? "flex h-4.75 shrink-0 items-center gap-1.5 empty:hidden"
    : "contents";

  return (
    <li
      data-thread-item={threadKey}
      {...sortableRootProps}
      {...(fileDropHandlers ?? {})}
      className={cn(
        // Matches the h-[3.375rem] content box; the py-0.5 padding is added on top.
        "list-none py-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_54px]",
        sortable?.isDragging && "relative z-20",
      )}
    >
      <Tooltip disabled={snoozeMenuOpen || sortable?.isDragging}>
        <TooltipTrigger
          render={
            <div
              ref={rowRef}
              {...prefetchIntent}
              data-sidebar-thread-row
              data-sidebar-pending={props.isPending || undefined}
              role="button"
              tabIndex={0}
              aria-label={accessibility.label}
              aria-current={accessibility.current}
              data-testid="sidebar-row-card"
              aria-busy={isRegeneratingTitle || props.isPending || undefined}
              className={rowSurfaceClassName}
              onClick={handleClick}
              onDoubleClick={handleDoubleClick}
              onKeyDown={handleKeyDown}
              onContextMenu={handleContextMenu}
            />
          }
        >
          {accessibleTitle}
          <div
            className={cn(
              "relative z-10 h-[3.375rem] px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)",
              props.paint && "flex items-center gap-2",
            )}
          >
            {paint ? <SessionBoxPainting box={paint} size={30} /> : null}
            {/* Without a painting the two lines keep the row's own layout. */}
            <div className={props.paint ? "min-w-0 flex-1" : "contents"}>
              <div
                className={cn(
                  "flex min-w-0 gap-1.5",
                  wrapsTitle ? "h-full items-start" : "h-5 items-center",
                )}
              >
                <span className={firstLine}>
                  {draftIndicator}
                  {unreadDot}
                </span>
                {title}
                {isRegeneratingTitle ? (
                  <span role="status" className="sr-only">
                    Regenerating title
                  </span>
                ) : null}
                <span className={firstLine}>{pinIndicator}</span>
                <div
                  className={
                    wrapsTitle ? "ml-auto flex h-full shrink-0 flex-col items-end" : "contents"
                  }
                >
                  {/* The visible state owns this slot's width: status at rest,
                  actions on hover/keyboard focus or while the popover is open. Keeping
                  the hidden state out of flow lets the project label reclaim
                  space without either state overlapping it. */}
                  {sortable?.isDragging ? (
                    dragDestination
                  ) : (
                    <span
                      className={cn(
                        "group/sidebar-status-slot relative ml-auto flex h-5 min-w-8 shrink-0 items-stretch justify-end text-xs",
                        props.sweepAction !== null && "hidden",
                      )}
                    >
                      {/* Read-only status labels yield to the hover actions. Woke is
                    itself an action, so it stays pointer-enabled and visible
                    while the other controls appear beside it. */}
                      <span
                        className={cn(
                          // The label keeps its place and only fades: when it left the flow
                          // the wider actions took its width and the title re-wrapped
                          // under the pointer.
                          isWokeStatus
                            ? "pointer-events-auto"
                            : "pointer-events-none group-has-[:focus-visible]/sidebar-status-slot:opacity-0 group-any-hover/sidebar-row:opacity-0",
                          "flex items-center self-center justify-self-end tabular-nums text-secondary-label transition-opacity",
                          snoozeMenuOpen && !isWokeStatus && "pointer-events-none opacity-0",
                          snoozeMenuOpen &&
                            isWokeStatus &&
                            "pointer-events-none absolute right-0 opacity-0",
                        )}
                      >
                        {topStatus ? (
                          isWokeStatus ? (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <button
                                    type="button"
                                    aria-label="Dismiss Woke notification"
                                    onClick={handleAcknowledgeWokeClick}
                                    className={cn(
                                      "inline-flex cursor-pointer items-center gap-1 rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                                      topStatus.className,
                                    )}
                                  >
                                    <AlarmClockIcon aria-hidden className="size-4 shrink-0" />
                                    <span role="status">{topStatus.label}</span>
                                  </button>
                                }
                              />
                              <TooltipPopup side="top">Dismiss Woke notification</TooltipPopup>
                            </Tooltip>
                          ) : (
                            <span
                              className={cn(
                                "inline-flex items-center gap-1 font-medium",
                                topStatus.className,
                              )}
                            >
                              {/* A painted row's badge already shows what it is doing. */}
                              {props.paint ? null : topStatus.icon === "working" ? (
                                <WorkingStatusIndicator className="size-4 shrink-0" />
                              ) : topStatus.icon === "waiting" ? (
                                <CircleDotDashedIcon aria-hidden className="size-4 shrink-0" />
                              ) : topStatus.icon === "input" ? (
                                <MessageCircleQuestionIcon
                                  aria-hidden
                                  className="size-4 shrink-0"
                                />
                              ) : topStatus.icon === "approval" ? (
                                <ShieldQuestionIcon aria-hidden className="size-4 shrink-0" />
                              ) : topStatus.icon === "failed" ? (
                                <CircleAlertIcon aria-hidden className="size-4 shrink-0" />
                              ) : null}
                              {/* The label alone is the live region: a role="status"
                            wrapper around the ticking duration would make
                            screen readers announce every second. */}
                              <span role="status">{topStatus.label}</span>
                              {status === "working" ? (
                                <span aria-hidden>
                                  {/* Quiet counts from the last sign of life, not the turn's start. */}
                                  <WorkingDuration
                                    startedAt={
                                      isQuiet ? lastActivityAt : resolveWorkingStartedAt(thread)
                                    }
                                  />
                                </span>
                              ) : status === "waiting" ? (
                                <span aria-hidden>
                                  <WorkingDuration
                                    startedAt={resolveThreadWaitingStartedAt(thread)}
                                  />
                                </span>
                              ) : null}
                            </span>
                          )
                        ) : (
                          threadTimeLabel(thread, nowMs)
                        )}
                      </span>
                      {hasRowActions ? (
                        <span
                          data-sidebar-row-actions
                          className={cn(
                            // focus-visible, not focus-within: a mouse click leaves
                            // the Settle button focused, and a plain focus-within
                            // would keep the controls pinned over the status label
                            // once the pointer moves away (e.g. after a failed
                            // settle) instead of cross-fading back.
                            // Laid over the row's right edge, where the title fades out
                            // beneath them. A Woke label stays visible, so there they
                            // take their own width beside it as before.
                            "pointer-events-none absolute inset-y-0 right-0 z-10 flex items-stretch opacity-0 transition-opacity has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100",
                            isWokeStatus &&
                              "has-[:focus-visible]:static group-any-hover/sidebar-row:static",
                            snoozeMenuOpen && "pointer-events-auto opacity-100",
                            snoozeMenuOpen && isWokeStatus && "static",
                          )}
                        >
                          {canUnpin && pinYieldsToActions ? (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  // The pointer's copy of the pin button, which hides while
                                  // these show. Keyboard and screen readers keep the one above.
                                  <button
                                    type="button"
                                    tabIndex={-1}
                                    aria-hidden
                                    data-testid={`sidebar-unpin-action-${thread.id}`}
                                    onClick={handleUnpinClick}
                                    className="inline-flex cursor-pointer items-center rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                                  />
                                }
                              >
                                <PinOffIcon className="size-3" />
                              </TooltipTrigger>
                              <TooltipPopup side="top">Unpin chat</TooltipPopup>
                            </Tooltip>
                          ) : null}
                          {hasUnsentDraft ? (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <button
                                    type="button"
                                    aria-label="Discard draft"
                                    onClick={handleDiscardDraftClick}
                                    className="inline-flex cursor-pointer items-center rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                                  />
                                }
                              >
                                <XIcon className="size-3.5" />
                              </TooltipTrigger>
                              <TooltipPopup side="top">Discard draft</TooltipPopup>
                            </Tooltip>
                          ) : null}
                          {showSnoozeButton ? (
                            <SnoozeMenuButton
                              open={snoozeMenuOpen}
                              onOpenChange={setSnoozeMenuOpen}
                              onSnooze={handleSnoozePreset}
                              timestampFormat={props.timestampFormat}
                            />
                          ) : null}
                          {props.settlementSupported ? (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <button
                                    type="button"
                                    aria-label="Settle chat"
                                    disabled={props.isPending}
                                    onClick={handleSettleClick}
                                    onPointerDown={handleActionPointerDown}
                                    className="-mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                                  />
                                }
                              >
                                {/* Icon only, named by its tooltip: with the word the actions
                                were three times the status they replace and hid the title. */}
                                <CheckIcon className="size-3.5" />
                              </TooltipTrigger>
                              <TooltipPopup>Settle chat</TooltipPopup>
                            </Tooltip>
                          ) : null}
                        </span>
                      ) : null}
                    </span>
                  )}
                  {/* A sweep hides the slot rather than unmounting it, so the
                  pressed action button stays connected and a cancelled sweep's
                  release click still fires and is consumed. */}
                  {props.sweepAction !== null ? dragDestination : null}
                  {wrapsTitle ? (
                    <div className="mt-auto flex h-4 items-center gap-1.5 text-secondary-label text-xs">
                      {processStatusIcons}
                      {trailingIcons}
                    </div>
                  ) : null}
                </div>
              </div>
              {wrapsTitle ? null : (
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-secondary-label text-xs">
                  {thread.source.comparison ? (
                    <span className="shrink-0 text-muted-foreground">
                      {thread.source.comparison.threadIds.length} models
                    </span>
                  ) : null}
                  {/* Always the branch. The plan step used to take this slot while
                  working, but it truncated to a half-sentence and dropped the
                  branch, so the row lost its most stable identifier. */}
                  {waitingLine !== null ? (
                    <span role="status" className="min-w-0 flex-1 truncate">
                      {waitingLine}
                    </span>
                  ) : shownBranch ? (
                    <>
                      <ThreadWorktreeIndicator thread={checkoutThread} />
                      <span className="flex min-w-0 flex-1 text-muted-foreground/40">
                        <MiddleTruncate
                          value={privateLabel("Branch", thread.id, shownBranch)}
                          showTitle={false}
                        />
                      </span>
                    </>
                  ) : showsScratchMachine ? (
                    <>
                      <EnvironmentMachineIcon
                        aria-hidden
                        kind={props.environmentMachine}
                        className="size-3 shrink-0 text-muted-foreground/40"
                      />
                      <span className="min-w-0 flex-1 truncate text-muted-foreground/40">
                        {props.scratchMachineLabel}
                      </span>
                    </>
                  ) : (
                    <span className="flex-1" />
                  )}
                  {processStatusIcons}
                  {prBadge}
                  {diff ? (
                    <span className="shrink-0 font-mono">
                      <span className="text-diff-addition-foreground">
                        +{formatDiffCount(diff.insertions)}
                      </span>{" "}
                      <span className="text-diff-deletion-foreground">
                        −{formatDiffCount(diff.deletions)}
                      </span>
                    </span>
                  ) : null}
                  {trailingIcons}
                </div>
              )}
            </div>
          </div>
          {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
        </TooltipTrigger>
        {detailsTooltip}
      </Tooltip>
    </li>
  );
});

function latestRunDiff(
  thread: SidebarThreadSummary,
): { insertions: number; deletions: number } | null {
  // Shells don't carry checkpoint summaries; diff stats render only when the
  // shell projection grows them. Kept as a seam so the row layout is ready.
  void thread;
  return null;
}

const SidebarSearchResultRow = memo(function SidebarSearchResultRow(props: {
  isSettled: boolean;
  thread: SidebarThreadSummary;
  prefetch: SidebarPrefetch;
  threadPrefetch: SidebarThreadPrefetch;
  project: EnvironmentProject | null;
  projectDisplayName: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
  isHighlighted: boolean;
  isRouteActive: boolean;
  resultId: string;
  resultIndex: number;
  resultCount: number;
  searchMatch: EnvironmentThreadSearchMatch | null;
  searchQuery: string;
  onHighlight: () => void;
  onSelect: () => void;
  onFileDropThreads: (threadRef: ScopedThreadRef, files: File[]) => void;
}) {
  const { thread } = props;
  const privateLabel = usePrivacyLabel();
  const privacy = usePrivacyMode();
  const attentionLabel = sidebarThreadAttentionLabel(thread);
  const accessibility = resolveSidebarRowAccessibility({
    title: privateLabel("Chat", thread.id, thread.title),
    statusLabel: attentionLabel,
    projectDisplayName: props.projectDisplayName,
    isActive: props.isRouteActive,
  });
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const localLastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  // A failure the user has already opened keeps its label without the color.
  const nowMs = useNowMinuteMs();
  const attentionAsks = sidebarThreadNeedsYou(thread, localLastVisitedAt, nowMs);
  const prefetchIntent = useSidebarPrefetchIntent(
    scopedThreadKey(threadRef),
    props.prefetch,
    props.threadPrefetch,
    sidebarPrefetchRevision(thread),
    props.isRouteActive,
  );
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(
    props.isHighlighted || props.isRouteActive,
  );
  // Same details tooltip as the regular rows: a search hit is still a thread,
  // and the hover card is how you disambiguate identically-titled results.
  const gitCwd = thread.worktreePath ?? props.project?.workspaceRoot ?? null;
  const gitStatus = useEnvironmentQuery(
    leaseLiveStatus && (thread.branch != null || thread.worktreePath !== null) && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd, includeRemote: false },
        })
      : null,
  );
  const visibleGitStatus = useRetainedValue(
    JSON.stringify([thread.environmentId, gitCwd]),
    gitStatus.data,
  );
  const checkoutThread = withoutRemovedCheckout(thread, visibleGitStatus);
  const branchMismatch = resolveLocalCheckoutBranchMismatch({
    effectiveEnvMode: thread.worktreePath === null ? "local" : "worktree",
    activeWorktreePath: thread.worktreePath,
    activeThreadBranch: thread.branch,
    currentGitBranch: visibleGitStatus?.refName ?? null,
  });
  const modelInstanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const providerEntry = props.providerEntryByInstanceId.get(modelInstanceId) ?? null;
  const showInstanceBadge =
    providerEntry !== null &&
    shouldShowInstanceBadge(providerEntry, props.providerEntryByInstanceId.values());
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelLabel(selectedModel)
    : thread.modelSelection.model;
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  // Read here, not as `props.onFileDropThreads(...)` in the memo: the React Compiler takes that
  // call to depend on all of `props`, cannot keep the memo, and skips this row.
  const { onFileDropThreads } = props;
  const fileDropHandlers = useMemo(
    () =>
      makeWorkspaceFileDropHandlers({
        setDragActive: setIsFileDragOver,
        addFiles: (files) => {
          onFileDropThreads(threadRef, files);
        },
        addFolders: () => {},
      }),
    [onFileDropThreads, threadRef],
  );
  useEffect(() => {
    if (!isFileDragOver) return;
    const clearFileDrag = () => setIsFileDragOver(false);
    window.addEventListener("dragend", clearFileDrag);
    return () => window.removeEventListener("dragend", clearFileDrag);
  }, [isFileDragOver]);
  return (
    <li role="presentation" className="list-none" {...fileDropHandlers}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              ref={rowRef}
              {...prefetchIntent}
              id={props.resultId}
              type="button"
              role="option"
              // aria-activedescendant options: focus stays on the search input,
              // which owns all keyboard interaction for the listbox.
              tabIndex={-1}
              aria-selected={props.isHighlighted}
              aria-posinset={props.resultIndex + 1}
              aria-setsize={props.resultCount}
              aria-current={accessibility.current}
              aria-describedby={`${props.resultId}-pr`}
              aria-label={accessibility.label}
              onMouseMove={props.onHighlight}
              // Focus stays in the search box, as for Enter. A focused result would lose focus as
              // the results close, and its recovery scrolls the list away from the opened thread.
              onPointerDown={(event) => {
                prefetchIntent.onPointerDown(event);
                event.preventDefault();
              }}
              onClick={props.onSelect}
              className={cn(
                "group/sidebar-row group/v2-row flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1 text-left text-sm outline-none",
                props.isHighlighted || props.isRouteActive
                  ? "bg-sidebar-row-active text-sidebar-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-row-hover",
                isFileDragOver && "ring-1 ring-inset ring-primary/70",
                isFileDragOver && !props.isRouteActive && "bg-sidebar-row-hover",
              )}
            />
          }
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-2.5">
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-foreground",
                  thread.titleRegeneration != null && "opacity-55",
                )}
              >
                {privateLabel("Chat", thread.id, thread.title)}
              </span>
              <span id={`${props.resultId}-pr`} className="contents">
                <ThreadSearchPullRequestNumber
                  thread={thread}
                  query={props.searchQuery}
                  enabled={leaseLiveStatus}
                  settled={props.isSettled}
                />
              </span>
              <span className="w-8 shrink-0 text-right text-xs text-secondary-label tabular-nums">
                {threadTimeLabel(thread, nowMs)}
              </span>
            </span>
            {thread.source.comparison ? (
              <span className="text-2xs text-muted-foreground">
                {thread.source.comparison.threadIds.length} models
              </span>
            ) : null}
            {attentionLabel ? (
              <span
                className={cn(
                  "text-2xs",
                  attentionAsks ? "text-warning-foreground" : "text-muted-foreground",
                )}
              >
                {attentionLabel}
              </span>
            ) : null}
            {props.searchMatch && !privacy ? (
              <ThreadSearchMatchExcerpt
                match={{
                  source: props.searchMatch.source,
                  snippet: props.searchMatch.snippet,
                  query: props.searchQuery,
                }}
              />
            ) : null}
          </span>
        </TooltipTrigger>
        <SidebarThreadTooltip
          thread={checkoutThread}
          prefetch={props.prefetch}
          project={props.project}
          projectDisplayName={props.projectDisplayName}
          environmentLabel={props.environmentLabel}
          environmentMachine={props.environmentMachine}
          providerEntry={providerEntry}
          providerEntryByInstanceId={props.providerEntryByInstanceId}
          showInstanceBadge={showInstanceBadge}
          modelInstanceId={modelInstanceId}
          modelLabel={modelLabel}
          branchMismatch={branchMismatch}
          terminalStatus={terminalStatus}
          terminalProcessCount={runningTerminalIds.length}
        />
      </Tooltip>
    </li>
  );
});

/** Memoized: the layout around it re-renders on every navigation. */
export default memo(function Sidebar() {
  const privateLabel = usePrivacyLabel();
  const privacy = usePrivacyMode();
  // Only rows the pointer rests on, not every row it crosses on the way to a click.
  const prefetch = useMemo(
    () => createSidebarPrefetch({ load: loadSidebarPreview, delayMs: 250 }),
    [],
  );
  // Warm the chat's decoded snapshot into the 5-minute resume cache on pointerdown, ahead of
  // the click that opens it, capped to one in-flight load at a time.
  const threadPrefetch = useMemo(
    () =>
      createSidebarPrefetch({
        load: prefetchSidebarThread,
        concurrency: 1,
        cacheSize: 16,
        cacheMs: SIDEBAR_THREAD_PREFETCH_CACHE_MS,
      }),
    [],
  );
  // Effect replay cancels work without disabling this reusable controller.
  useEffect(() => {
    return () => {
      prefetch.cancel();
      threadPrefetch.cancel();
    };
  }, [prefetch, threadPrefetch]);
  const pendingActionsStore = useMemo(() => createSidebarPendingActions(), []);
  const pendingActions = useSyncExternalStore(
    pendingActionsStore.subscribe,
    pendingActionsStore.snapshot,
    pendingActionsStore.snapshot,
  );
  useEffect(() => () => pendingActionsStore.cancel(), [pendingActionsStore]);
  const [uiMode] = useUiMode();
  const discordMode = uiMode === "discord";
  const { environments: machineEnvironments, presentationById } = useEnvironments();
  const [machineSelection, setMachineSelection] = useLocalStorage(
    "t3code:sidebar:machine-filter:v1",
    "all",
    Schema.String,
  );
  const selectedMachineId = machineEnvironments.some(
    (environment) => environment.environmentId === machineSelection,
  )
    ? machineSelection
    : "all";
  const [collapsedDiscordCategories, setCollapsedDiscordCategories] = useLocalStorage<
    readonly string[],
    readonly string[]
  >("t3code:discord:collapsed-categories:v1", ["settled"], Schema.Array(Schema.String));
  const projects = useProjects();
  const allThreads = useThreadShells();
  const hiddenWorkflowChats = useHiddenWorkflowChatKeys();
  const threads = useMemo(
    () => groupComparisonThreads(withoutWorkflowRunChats(allThreads, hiddenWorkflowChats)),
    [allThreads, hiddenWorkflowChats],
  );
  const machineForThread = useCallback(
    (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) => thread.environmentId,
    [],
  );
  const router = useRouter();
  const openBeside = useOpenChatBeside();
  const { isMobile, setOpenMobile, open, openMobile } = useSidebar();
  const sidebarVisible = isMobile ? openMobile : open;
  useEffect(() => {
    const cancel = () => {
      prefetch.cancel();
      threadPrefetch.cancel();
    };
    const visibility = () => {
      if (document.hidden) cancel();
    };
    if (!sidebarVisible) cancel();
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [prefetch, threadPrefetch, sidebarVisible]);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const workingShelfEnabled = useClientSettings((s) => s.sidebarWorkingShelfEnabled);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const {
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    confirmAndUnpinThread,
    setThreadAutoSettle,
    reorderPinnedThread,
    reorderActiveThread,
    markThreadUnread,
    archiveThread,
    deleteThread,
  } = useThreadActions();
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: path,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const { copyToClipboard: copyBranchToClipboard } = useCopyToClipboard<{ branch: string }>({
    target: "branch name",
    onCopy: ({ branch }) => {
      toastManager.add({
        type: "success",
        title: "Branch copied",
        description: branch,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy branch",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    onCopy: ({ threadId }) => {
      toastManager.add({
        type: "success",
        title: "Chat ID copied",
        description: threadId,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy chat ID",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const newThreadContext = useHandleNewThread();
  const { scratchEnvironmentId, startScratchThread } = useScratchProject();
  const environments = useEnvironmentIdentities();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryPending = usePrimaryEnvironmentPending();
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const acknowledgeWoke = useAcknowledgeThreadWoke();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeDraftThread = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const routeThreadRef = useMemo(
    () => resolveActiveThreadRouteRef(routeTarget, routeDraftThread),
    [routeDraftThread, routeTarget],
  );
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  const routeTargetRef = useRef(routeTarget);
  routeTargetRef.current = routeTarget;
  // Post-settle navigation validates against the CURRENT route, not the one
  // captured when the settle started: if the user navigated elsewhere while
  // the command was in flight, completing it must not yank them away.
  const routeThreadKeyRef = useCommittedRef(routeThreadKey);
  const openChatHeldRef = useRef<{ key: string | null; held: boolean }>({
    key: null,
    held: false,
  });
  // While the mouse is over the list, rows keep the order last shown.
  const [sessionListHovered, setSessionListHovered] = useState(false);
  const shownActiveOrderRef = useRef<readonly string[]>([]);

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map(
          (environment) =>
            [
              environment.environmentId,
              privateLabel("Computer", environment.environmentId, environment.label),
            ] as const,
        ),
      ),
    [environments, privateLabel],
  );
  const environmentMachineById = useEnvironmentMachines();
  const projectGroups = useSidebarProjectGroups();
  const projectGroupsRef = useCommittedRef(projectGroups);
  // Threads on non-primary environments (T3 Connect, hosted) resolve their
  // provider entry from their own environment's config: default instance ids
  // are driver slugs, so a flat map would collide across environments.
  const providerEntriesByEnvironment = useMemo(
    () =>
      deriveProviderEntriesByEnvironment(
        [...serverConfigs].map(
          ([environmentId, config]) => [environmentId, config.providers, config.settings] as const,
        ),
      ),
    [serverConfigs],
  );
  // Rows read the project record for its icon and cwd. Group labels can include
  // a repository owner or a different title, so they travel separately.
  const projectByKey = useMemo(
    () => new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project])),
    [projects],
  );
  // Threads without a project name nothing, in hover cards and screen reader labels too.
  const projectDisplayNameByKey = useMemo(
    () =>
      new Map(
        projectGroups.flatMap((group) =>
          group.memberProjects.flatMap((project) =>
            isScratchProject(
              project,
              serverConfigs.get(project.environmentId)?.scratchWorkspaceRoot,
            )
              ? []
              : [
                  [
                    `${project.environmentId}:${project.id}`,
                    privateLabel("Project", group.projectKey, group.displayName),
                  ] as const,
                ],
          ),
        ),
      ),
    [projectGroups, serverConfigs, privateLabel],
  );
  const projectDisplayNameByKeyRef = useCommittedRef(projectDisplayNameByKey);

  const nowMinute = useNowMinute();
  const changeRequestSnapshotByKey = useAtomValue(threadChangeRequestSnapshotsAtom);
  // Snooze wake times are second-precise, so classifying with the quantized
  // minute would hold a woken thread on the shelf for up to a minute. The
  // tick is a plain counter bumped exactly at the next wake boundary (armed
  // below, after the partition knows the boundary); the partition reads a
  // fresh clock whenever it recomputes.
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);

  // Same-named projects on two machines are only told apart by where they
  // live, so rows on another machine carry its icon once the catalog spans
  // more than one environment; a single-machine catalog stays as it was.
  const showProjectEnvironments = useMemo(
    () => projectGroupsSpanEnvironments(projectGroups),
    [projectGroups],
  );
  // Only chats on another machine name it: on every row, "this Mac" would only crowd the
  // titles.
  const scratchMachineLabelFor = (
    thread: Pick<SidebarThreadSummary, "environmentId" | "projectId">,
  ) => {
    if (!showProjectEnvironments || thread.environmentId === primaryEnvironmentId) return null;
    const project = projectByKey.get(`${thread.environmentId}:${thread.projectId}`);
    if (
      !project ||
      !isScratchProject(project, serverConfigs.get(thread.environmentId)?.scratchWorkspaceRoot)
    ) {
      return null;
    }
    return environmentLabelById.get(thread.environmentId) ?? null;
  };
  // Count-only subscription: the parent needs "are there draft rows" for the
  // empty state, while SidebarDraftBlock owns the per-keystroke content
  // subscription. Selecting a number keeps typing in a draft composer from
  // re-rendering the whole sidebar. Approximates the block's row filter
  // (every non-promoted session with content); it can overcount by one for
  // an open never-left draft, which only softens the empty state.
  const routeDraftIdForRows = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  const visibleDraftSessionCount = useComposerDraftStore((store) => {
    let count = 0;
    for (const [draftKey, session] of Object.entries(store.draftThreadsByThreadKey)) {
      if (session.promotedTo != null) {
        continue;
      }
      if (!composerDraftHasUserContent(store.draftsByThreadKey[draftKey])) {
        continue;
      }
      count += 1;
    }
    return count;
  });
  const openProjectSettings = useStableCallback(
    (projectGroup: SidebarProjectSnapshot, projectRef?: ScopedProjectRef) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({
        to: "/projects/$projectKey",
        params: {
          projectKey: getSidebarProjectSettingsKey(
            projectGroup,
            projectGroupingSettings,
            projects,
            projectRef,
          ),
        },
      });
    },
  );
  // Keep a dropped row at its destination while its server applies the
  // lifecycle command and any order-key writes. The next pickup waits for
  // this hold so a second drop cannot replace an unconfirmed placement.
  const [optimisticDrop, setOptimisticDrop] = useState<{
    readonly key: string;
    readonly sourceSection: SidebarSection;
    readonly section: "pinned" | "active" | "settled";
    readonly id: symbol;
    readonly commandsComplete: boolean;
    readonly occurredAt: string;
    readonly clearsSnooze: boolean;
    /** Full destination order for pinned and active drops. */
    readonly order: readonly string[] | null;
    /** Destination order keys before the drop, to recognize concurrent writes. */
    readonly keysAtDrop: ReadonlyMap<string, string | null>;
    /** The keys this drop writes (one per planned assignment). The
        override holds until all of them appear in canonical state. */
    readonly assignedKeys: ReadonlyMap<string, string | null>;
  } | null>(null);
  const beginSidebarAction = useCallback(
    (threadRef: ScopedThreadRef, action: SidebarPendingAction) => {
      if (
        optimisticDrop !== null ||
        !readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)
      )
        return null;
      return pendingActionsStore.begin(scopedThreadKey(threadRef), action);
    },
    [pendingActionsStore, optimisticDrop],
  );
  // Chat tabs: the strip above the list shows one tab's chats at a time, like browser tab
  // groups. Which tab is open is this device's choice.
  const [chatTabSelection, setChatTabSelection] = useLocalStorage(
    CHAT_TAB_SELECTION_KEY,
    ALL_CHATS_TAB,
    Schema.String,
  );
  const runChatTabsCommand = useAtomCommand(serverEnvironment.chatTabsCommand, {
    reportFailure: false,
  });
  const chatTabStripRef = useRef<HTMLDivElement | null>(null);
  const [discordServerSettings, setDiscordServerSettings] = useState<{
    tab: ChatTabView | null;
    threads?: readonly ScopedThreadRef[];
    suggestedName?: string;
  } | null>(null);
  const [chatTabDropTarget, setChatTabDropTarget] = useState<string | null>(null);
  const [renamingChatTab, setRenamingChatTab] = useState<string | null>(null);
  const chatTabViews = useMemo(
    () =>
      buildChatTabs(filterSidebarV2VisibleThreads(threads, null), {
        catalog: [...serverConfigs].flatMap(([environmentId, config]) =>
          (config.chatTabs ?? []).map((tab) => ({ environmentId, tab })),
        ),
        threadKey: (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        status: (thread) => {
          const status = resolveSidebarDisplayStatus(
            resolveSidebarThreadStatus(thread),
            presentationById.get(thread.environmentId)?.connection.phase,
          );
          return status === "approval" || status === "input"
            ? "attention"
            : status === "working"
              ? "working"
              : null;
        },
      }),
    [threads, presentationById, serverConfigs],
  );
  const [terminalQuery, setTerminalQuery] = useState("");
  const terminalRouteActive = useLocation({
    select: (location) => /^\/terminal(?:\/|$)/.test(location.pathname),
  });
  const terminalRoute = useParams({
    strict: false,
    select: (params) => ({ sessionId: params.sessionId, environmentId: params.environmentId }),
  });
  useEffect(() => {
    if (!terminalRouteActive) return;
    setChatTabSelection(CLAUDE_RC_TAB);
    if (terminalRoute.environmentId) setMachineSelection(terminalRoute.environmentId);
  }, [terminalRouteActive, terminalRoute.environmentId, setChatTabSelection, setMachineSelection]);
  const selectedChatTab =
    chatTabSelection === CLAUDE_RC_TAB
      ? CLAUDE_RC_TAB
      : resolveSelectedChatTab(chatTabSelection, chatTabViews);
  const showingTerminalSessions = selectedChatTab === CLAUDE_RC_TAB;
  const chatTabViewsRef = useRef(chatTabViews);
  chatTabViewsRef.current = chatTabViews;
  const selectedChatTabRef = useRef(selectedChatTab);
  selectedChatTabRef.current = selectedChatTab;
  const sendChatTabsCommand = useStableCallback(
    async (environmentIds: Iterable<EnvironmentId>, input: ChatTabsCommand) => {
      const results = await Promise.all(
        [...new Set(environmentIds)]
          .filter(
            (environmentId) =>
              serverConfigs.get(environmentId)?.environment.capabilities.chatTabs === true,
          )
          .map((environmentId) => runChatTabsCommand({ environmentId, input })),
      );
      for (const result of results) {
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) continue;
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not update tabs",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return false;
      }
      return results.length > 0;
    },
  );
  /** Files chats in the tab with this name (made if new), or takes them out of tabs. */
  const moveChatsToTab = useStableCallback(
    async (refs: ReadonlyArray<ScopedThreadRef>, tab: string | null) => {
      const byEnvironment = new Map<EnvironmentId, ThreadId[]>();
      for (const ref of refs) {
        byEnvironment.set(ref.environmentId, [
          ...(byEnvironment.get(ref.environmentId) ?? []),
          ref.threadId,
        ]);
      }
      const results = await Promise.all(
        [...byEnvironment].map(([environmentId, threadIds]) =>
          sendChatTabsCommand([environmentId], { action: "move", threadIds, tab }),
        ),
      );
      return results.every(Boolean);
    },
  );
  /** "New tab…": a tab named after the first chat, renamed in place right away. */
  const moveChatsToNewTab = useStableCallback(
    (refs: ReadonlyArray<ScopedThreadRef>, firstTitle: string) => {
      if (discordMode) {
        setDiscordServerSettings({
          tab: null,
          threads: refs,
          suggestedName: cleanChatTabName(firstTitle),
        });
        return;
      }
      const base = cleanChatTabName(firstTitle) || "New tab";
      const taken = new Set(chatTabViewsRef.current.map((tab) => tab.key));
      let name = base;
      for (let suffix = 2; taken.has(chatTabKey(name)); suffix += 1) {
        name = cleanChatTabName(`${base.slice(0, CHAT_TAB_NAME_MAX_LENGTH - 4)} ${suffix}`);
      }
      moveChatsToTab(refs, name);
      setRenamingChatTab(chatTabKey(name));
    },
  );
  const pickChatTabMenu = useStableCallback(
    (refs: ReadonlyArray<ScopedThreadRef>, id: ChatTabMenuId, firstTitle: string) => {
      const action = parseChatTabMenuId(id);
      if (action?.kind === "new") moveChatsToNewTab(refs, firstTitle);
      else if (action?.kind === "remove") moveChatsToTab(refs, null);
      else if (action?.kind === "move") {
        const tab = chatTabViewsRef.current.find((candidate) => candidate.key === action.key);
        if (tab) moveChatsToTab(refs, tab.name);
      }
    },
  );
  /** "Move to tab" for these chats, or nothing when none of their machines keeps tabs. */
  const chatTabMenuFor = (
    chats: ReadonlyArray<Pick<EnvironmentThreadShell, "environmentId" | "id" | "source">>,
    count?: number,
  ): ContextMenuItem<ChatTabMenuId> | null => {
    if (
      !chats.some(
        (chat) => serverConfigs.get(chat.environmentId)?.environment.capabilities.chatTabs === true,
      )
    ) {
      return null;
    }
    const keys = new Set(
      chats.map(
        (chat) =>
          chatTabViewsRef.current.find((tab) =>
            tab.threadKeys.has(scopedThreadKey(scopeThreadRef(chat.environmentId, chat.id))),
          )?.key ?? null,
      ),
    );
    return moveToChatTabMenuItem({
      tabs: chatTabViewsRef.current,
      discord: discordMode,
      currentKey: keys.size === 1 ? ([...keys][0] ?? null) : null,
      inSomeTab: chats.some((chat) => chat.source.chatTab != null),
      ...(count === undefined ? {} : { count }),
    });
  };
  const chatTabEnvironments = (tab: ChatTabView) => [
    ...new Set([
      ...[...(tab.environmentIds ?? [])].map((id) => EnvironmentId.make(id)),
      ...[...tab.threadKeys].flatMap((key) => {
        const ref = parseScopedThreadKey(key);
        return ref === null ? [] : [ref.environmentId];
      }),
    ]),
  ];
  const renameChatTab = useStableCallback((tab: ChatTabView, name: string) => {
    void sendChatTabsCommand(chatTabEnvironments(tab), {
      action: "rename",
      tab: tab.name,
      to: name,
    });
    if (selectedChatTabRef.current === tab.key) {
      setChatTabSelection(chatTabKey(cleanChatTabName(name)));
    }
  });
  const handleChatTabContextMenu = useStableCallback(
    async (tab: ChatTabView, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const views = chatTabViewsRef.current;
      if (
        !chatTabEnvironments(tab).some((id) =>
          readEnvironmentScope(id, AuthOrchestrationOperateScope),
        )
      )
        return;
      const items = chatTabStripMenuItems(views, tab);
      const clicked = await settlePromise(() =>
        api.contextMenu.show(
          discordMode
            ? [
                { id: "chat-tab:server-settings", label: "Server settings", icon: "settings" },
                ...items.map((item) => ({
                  ...item,
                  label:
                    item.id === "chat-tab:rename"
                      ? "Rename server"
                      : item.id === "chat-tab:move-left"
                        ? "Move up"
                        : item.id === "chat-tab:move-right"
                          ? "Move down"
                          : item.id === "chat-tab:delete"
                            ? "Delete server (keep chats)"
                            : item.label,
                })),
              ]
            : items,
          position,
        ),
      );
      if (clicked._tag === "Failure" || clicked.value === null) return;
      if (clicked.value === "chat-tab:server-settings") {
        setDiscordServerSettings({ tab });
        return;
      }
      if (!isChatTabMenuId(clicked.value)) return;
      const action = parseChatTabMenuId(clicked.value);
      const index = views.findIndex((candidate) => candidate.key === tab.key);
      const environments = chatTabEnvironments(tab);
      switch (action?.kind) {
        case "rename":
          if (discordMode) setDiscordServerSettings({ tab });
          else setRenamingChatTab(tab.key);
          return;
        case "move-left": {
          const before = views[index - 1];
          if (before) {
            void sendChatTabsCommand(environments, {
              action: "reorder",
              tab: tab.name,
              before: before.name,
            });
          }
          return;
        }
        case "move-right":
          if (index < views.length - 1) {
            void sendChatTabsCommand(environments, {
              action: "reorder",
              tab: tab.name,
              before: views[index + 2]?.name ?? null,
            });
          }
          return;
        case "merge": {
          const target = views.find((candidate) => candidate.key === action.key);
          if (!target) return;
          void sendChatTabsCommand(environments, {
            action: "rename",
            tab: tab.name,
            to: target.name,
          });
          if (selectedChatTabRef.current === tab.key) setChatTabSelection(target.key);
          return;
        }
        case "delete":
          void sendChatTabsCommand(environments, { action: "delete", tab: tab.name });
          if (selectedChatTabRef.current === tab.key) setChatTabSelection(ALL_CHATS_TAB);
          return;
        default:
          return;
      }
    },
  );
  // Opening a chat from outside the strip's tab (search, a link, a notification) opens its
  // tab, so the chat you are in is always in the list. Choosing a tab never moves you, and
  // neither does a new chat's draft turning into the chat: both keep the same key.
  const routeIsDraftRef = useRef(routeTarget?.kind === "draft");
  routeIsDraftRef.current = routeTarget?.kind === "draft";
  useEffect(() => {
    if (routeThreadKey === null || routeIsDraftRef.current) return;
    const selected = selectedChatTabRef.current;
    const views = chatTabViewsRef.current;
    if (chatTabShowsThread(selected, views, routeThreadKey)) return;
    setChatTabSelection(
      views.find((tab) => tab.threadKeys.has(routeThreadKey))?.key ?? ALL_CHATS_TAB,
    );
  }, [routeThreadKey, setChatTabSelection]);
  // A chat started while a tab is open belongs to that tab, as a new browser tab opens in
  // the window you are in. Filing the draft's reserved id lets the chat arrive in its tab.
  const filedDraftKeysRef = useRef(new Set<string>());
  useEffect(() => {
    if (routeTarget?.kind !== "draft" || routeThreadRef === null) return;
    const tab = chatTabViews.find((candidate) => candidate.key === selectedChatTab);
    if (tab === undefined) return;
    const key = scopedThreadKey(routeThreadRef);
    if (filedDraftKeysRef.current.has(key)) return;
    filedDraftKeysRef.current.add(key);
    moveChatsToTab([routeThreadRef], tab.name);
  }, [chatTabViews, moveChatsToTab, routeTarget?.kind, routeThreadRef, selectedChatTab]);

  const {
    pinnedThreads,
    draggableThreadKeys,
    activeReorderableThreadKeys,
    activeThreads,
    workingThreads,
    snoozedThreads,
    settledThreads,
    snoozeNow,
  } = useMemo(() => {
    // Snooze classification uses a REAL clock, not the quantized minute:
    // wake times are second-precise and a woken thread must not linger on
    // the shelf for the rest of the minute. snoozeWakeTick re-runs this
    // memo exactly at the next wake boundary.
    void snoozeWakeTick;
    const preciseNow = new Date().toISOString();
    // Subagent child threads live in the parent's Agents surface, not the
    // sidebar roster (v2 models them as real threads with lineage), in Discord
    // mode too: nested under their parent they read as Discord threads and clutter it.
    const visible = filterSidebarV2VisibleThreads(threads, null).filter(
      (thread) =>
        chatTabShowsThread(
          selectedChatTab,
          chatTabViews,
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        ) &&
        (selectedMachineId === "all" || machineForThread(thread) === selectedMachineId),
    );
    inboxReturns.observe(workingShelfEnabled ? threads : null);
    const pinned: EnvironmentThreadShell[] = [];
    const active: EnvironmentThreadShell[] = [];
    const working: EnvironmentThreadShell[] = [];
    // Working beta: only inbox threads fold away. Pins stay where the user
    // put them, and snoozed or settled threads keep their shelves.
    const inbox = (thread: EnvironmentThreadShell) =>
      workingShelfEnabled && isSidebarThreadWorking(thread) ? working : active;
    const snoozed: EnvironmentThreadShell[] = [];
    const settled: EnvironmentThreadShell[] = [];
    const draggable = new Set<string>();
    const activeReorderable = new Set<string>();
    for (const thread of visible) {
      const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      const capabilities = serverConfigs.get(thread.environmentId)?.environment.capabilities;
      // Threads on servers without the settlement capability (old server,
      // or descriptor not loaded yet) never classify as settled: the user
      // could neither un-settle nor pin them, so auto-settling them would
      // strand rows in a tail with no working affordances.
      const supportsSettlement = capabilities?.threadSettlement === true;
      const supportsSnooze = capabilities?.threadSnooze === true;
      if (capabilities?.threadActiveReorder === true) activeReorderable.add(threadKey);
      // Older servers retain their existing drag actions. Active placement
      // additionally requires its own ordering capability at the drop target.
      if (capabilities?.threadPinning === true && capabilities.threadPinReorder === true) {
        draggable.add(threadKey);
      }
      if (optimisticDrop?.key === threadKey) {
        const projected = applySidebarThreadDrop(
          thread,
          optimisticDrop.section,
          optimisticDrop.occurredAt,
          optimisticDrop.assignedKeys.get(threadKey),
        );
        (optimisticDrop.section === "pinned"
          ? pinned
          : optimisticDrop.section === "settled"
            ? settled
            : inbox(projected)
        ).push(
          optimisticDrop.clearsSnooze
            ? projected
            : { ...projected, snoozedAt: thread.snoozedAt, snoozedUntil: thread.snoozedUntil },
        );
      } else {
        const section = resolveSidebarThreadSection({
          snoozed: supportsSnooze && effectiveSnoozed(thread, { now: preciseNow }),
          settled: belongsInSidebarSettledShelf(thread, supportsSettlement),
          pinned: thread.pinnedAt != null,
        });
        (section === "snoozed"
          ? snoozed
          : section === "settled"
            ? settled
            : section === "pinned"
              ? pinned
              : inbox(thread)
        ).push(thread);
      }
    }
    // One shared rule on every platform (see sortPinnedThreadsByOrderKey):
    // user-arranged keys first, keyless threads in creation order below.
    // Server capability only gates DRAGGING — it must not influence the
    // sort, or mixed-version fleets would render different pinned orders on
    // web and mobile from the same data.
    const sortedPinned = sortPinnedThreadsForSidebar(pinned);
    // Opening a chat marks it read. It keeps its place until you leave it, so
    // the row you clicked doesn't drop away under the pointer.
    const activeKey = (thread: EnvironmentThreadShell) =>
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const nowMs = Date.parse(`${nowMinute}:00.000Z`);
    if (openChatHeldRef.current.key !== routeThreadKey) {
      const open = active.find((thread) => activeKey(thread) === routeThreadKey);
      openChatHeldRef.current = {
        key: routeThreadKey,
        held: open !== undefined && sidebarSessionNeedsYou(open, nowMs),
      };
    }
    const held = openChatHeldRef.current;
    const sortedActive = sortSidebarSessions(active, {
      holdsNeedsYou: (thread) => held.held && activeKey(thread) === held.key,
      nowMs,
    });
    const shownActive =
      optimisticDrop?.section === "active" && optimisticDrop.order !== null
        ? orderItemsByPreferredIds({
            items: sortedActive,
            preferredIds: optimisticDrop.order,
            getId: activeKey,
          })
        : sessionListHovered
          ? holdSidebarOrder(sortedActive, shownActiveOrderRef.current, activeKey)
          : sortedActive;
    shownActiveOrderRef.current = shownActive.map(activeKey);
    return {
      pinnedThreads:
        optimisticDrop?.section !== "pinned" || optimisticDrop.order === null
          ? sortedPinned
          : orderItemsByPreferredIds({
              items: sortedPinned,
              preferredIds: optimisticDrop.order,
              getId: (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
            }),
      draggableThreadKeys: draggable,
      activeReorderableThreadKeys: activeReorderable,
      activeThreads: shownActive,
      // Newest send first; finishing and waking again do not move a row.
      workingThreads: sortWorkingThreadsBySend(working),
      // Soonest wake first: "what comes back next" is the shelf's question.
      snoozedThreads: snoozed.toSorted(
        (left, right) =>
          firstValidTimestampMs(left.snoozedUntil ?? null) -
          firstValidTimestampMs(right.snoozedUntil ?? null),
      ),
      settledThreads: sortSettledThreads(settled),
      snoozeNow: preciseNow,
    };
  }, [
    chatTabViews,
    selectedMachineId,
    machineForThread,
    discordMode,
    nowMinute,
    optimisticDrop,
    selectedChatTab,
    serverConfigs,
    routeThreadKey,
    sessionListHovered,
    snoozeWakeTick,
    threads,
    workingShelfEnabled,
  ]);

  const threadSearchInputRef = useRef<HTMLInputElement>(null);
  const [threadSearchQuery, setThreadSearchQuery] = useState("");
  const [quickFilter, setQuickFilter] = useState<SidebarQuickFilter>("all");
  const [searchVisibleCount, setSearchVisibleCount] = useState(SESSION_LIST_INITIAL_COUNT);
  const [activeSearchResultIndex, setActiveSearchResultIndex] = useState(0);
  const isSearchingThreads = threadSearchQuery.trim().length > 0;
  const isShowingThreadResults = isSearchingThreads || quickFilter !== "all";
  const searchableThreads = useMemo(() => {
    return [
      ...pinnedThreads,
      ...activeThreads,
      ...workingThreads,
      ...snoozedThreads,
      ...settledThreads,
      ...threads.filter((thread) => thread.archivedAt !== null),
    ];
  }, [activeThreads, pinnedThreads, settledThreads, snoozedThreads, workingThreads, threads]);
  const searchEnvironmentIds = useConnectedEnvironmentIds();
  // useThreadSearch owns the debounce and the two-character floor.
  const threadSearch = useThreadSearch(searchEnvironmentIds, threadSearchQuery);
  const threadSearchMatchByKey = useMemo(
    () =>
      new Map(threadSearch.matches.map((match) => [threadSearchMatchKey(match), match] as const)),
    [threadSearch.matches],
  );
  const threadLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const quickFilterResult = useMemo(
    () =>
      filterSidebarThreads(searchableThreads, quickFilter, threadLastVisitedAtById, discordMode),
    [searchableThreads, quickFilter, threadLastVisitedAtById, discordMode],
  );
  const threadSearchResults = useMemo(() => {
    if (!isSearchingThreads)
      return quickFilter === "all" ? EMPTY_THREADS : quickFilterResult.threads;
    // Subagent chats are opened from their lead's card; a search is for the chats you work in.
    const searchable = quickFilterResult.threads.filter(
      (thread) => !isSidebarSubagentThread(thread),
    );
    const titles = searchSidebarThreads(searchable, threadSearchQuery);
    const known = new Set(
      quickFilterResult.threads.map((thread) =>
        threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
      ),
    );
    const matches = threadSearch.matches.filter(
      (match) =>
        (selectedMachineId === "all" ||
          machineForThread({ environmentId: match.environmentId, id: match.threadId }) ===
            selectedMachineId) &&
        chatTabShowsThread(
          selectedChatTab,
          chatTabViews,
          scopedThreadKey(scopeThreadRef(match.environmentId, match.threadId)),
        ) &&
        (quickFilter === "all" || known.has(threadSearchMatchKey(match))),
    );
    return rankSidebarSearchResults({
      query: threadSearchQuery,
      titles,
      matches,
      known: quickFilterResult.threads,
      nameable: searchable,
    });
  }, [
    isSearchingThreads,
    quickFilter,
    quickFilterResult.threads,
    threadSearchQuery,
    threadSearch.matches,
    selectedMachineId,
    machineForThread,
    selectedChatTab,
    chatTabViews,
  ]);
  const visibleThreadSearchResults = useMemo(
    () => threadSearchResults.slice(0, searchVisibleCount),
    [threadSearchResults, searchVisibleCount],
  );
  useEffect(() => {
    if (!isShowingThreadResults || !sidebarVisible) return;
    const target = visibleThreadSearchResults[activeSearchResultIndex];
    if (!target || !("id" in target)) return;
    return prefetch.request(
      scopedThreadKey(scopeThreadRef(target.environmentId, target.id)),
      sidebarPrefetchRevision(target),
    );
  }, [
    activeSearchResultIndex,
    isShowingThreadResults,
    prefetch,
    sidebarVisible,
    visibleThreadSearchResults,
  ]);
  const threadSearchResultOrderKey = threadSearchResults
    .map((thread) =>
      scopedThreadKey(
        scopeThreadRef(thread.environmentId, "id" in thread ? thread.id : thread.threadId),
      ),
    )
    .join("\0");

  useEffect(() => {
    setActiveSearchResultIndex(0);
    setSearchVisibleCount(SESSION_LIST_INITIAL_COUNT);
  }, [threadSearchResultOrderKey]);

  useEffect(() => {
    if (!isShowingThreadResults) return;
    document
      .getElementById(`sidebar-thread-search-result-${activeSearchResultIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeSearchResultIndex, isShowingThreadResults, threadSearchResultOrderKey]);

  // Arm a timeout for the earliest upcoming wake so the shelf empties the
  // moment a snooze expires instead of on the next minute tick. Sorted
  // soonest-first, so entry 0 is the boundary.
  useEffect(() => {
    const nextWakeAtMs =
      snoozedThreads.length > 0 && snoozedThreads[0]?.snoozedUntil != null
        ? Date.parse(snoozedThreads[0].snoozedUntil)
        : Number.NaN;
    if (Number.isNaN(nextWakeAtMs)) return;
    // setTimeout delays are signed 32-bit: anything larger overflows and
    // fires immediately, turning a far-future wake (event-condition snoozes
    // synced from elsewhere) into a tight re-arm loop. Clamped, the timer
    // just re-arms every ~24.8 days until the wake is in range.
    const delayMs = Math.min(Math.max(0, nextWakeAtMs - Date.now()) + 50, 2_147_483_647);
    const id = window.setTimeout(() => bumpSnoozeWakeTick((tick) => tick + 1), delayMs);
    return () => window.clearTimeout(id);
  }, [snoozedThreads]);

  // The session list renders in pages: history shouldn't cost a row for
  // every thread ever started. Threads with a turn in flight sort first, and
  // the open thread is always kept, so neither can hide under "Show more".
  const [sessionVisibleCount, setSessionVisibleCount] = useState(SESSION_LIST_INITIAL_COUNT);
  const visibleActiveThreads = useMemo(() => {
    if (activeThreads.length <= sessionVisibleCount) return activeThreads;
    const visible = activeThreads.slice(0, sessionVisibleCount);
    if (routeThreadKey !== null) {
      const routeThread = activeThreads
        .slice(sessionVisibleCount)
        .find(
          (thread) =>
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
        );
      if (routeThread !== undefined) visible.push(routeThread);
    }
    return visible;
  }, [activeThreads, routeThreadKey, sessionVisibleCount]);
  const hiddenSessionCount = activeThreads.length - visibleActiveThreads.length;
  const showMoreSessions = useCallback(
    () => setSessionVisibleCount((count) => count + SESSION_LIST_PAGE_COUNT),
    [],
  );

  // Settled threads fold into a collapsed shelf at the bottom, as on iPhone,
  // and page once expanded. The open thread must never hide under the
  // collapsed shelf or "Show more": its row keeps the highlight and the
  // un-settle affordance.
  const [settledVisibleCount, setSettledVisibleCount] = useState(SETTLED_TAIL_INITIAL_COUNT);
  const visibleSettledThreads = useMemo(() => {
    if (settledThreads.length <= settledVisibleCount) return settledThreads;
    const visible = settledThreads.slice(0, settledVisibleCount);
    if (routeThreadKey !== null) {
      const routeThread = settledThreads
        .slice(settledVisibleCount)
        .find(
          (thread) =>
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
        );
      if (routeThread !== undefined) visible.push(routeThread);
    }
    return visible;
  }, [routeThreadKey, settledThreads, settledVisibleCount]);
  const hiddenSettledCount = settledThreads.length - visibleSettledThreads.length;
  const showMoreSettled = useCallback(
    () => setSettledVisibleCount((count) => count + SETTLED_TAIL_PAGE_COUNT),
    [],
  );
  const [settledShelfExpanded, setSettledShelfExpanded] = useLocalStorage(
    SETTLED_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const toggleSettledShelf = useCallback(
    () => setSettledShelfExpanded((value) => !value),
    [setSettledShelfExpanded],
  );
  const renderedSettledThreads = useMemo(() => {
    if (settledShelfExpanded) return visibleSettledThreads;
    if (routeThreadKey === null) return EMPTY_THREADS;
    const routeThread = visibleSettledThreads.find(
      (thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
    );
    return routeThread === undefined ? EMPTY_THREADS : [routeThread];
  }, [routeThreadKey, settledShelfExpanded, visibleSettledThreads]);

  // The snoozed shelf is collapsed by default: out of the way, never gone.
  // Collapsed threads don't render (and so don't participate in jump
  // shortcuts or multi-select), matching the settled tail's paging model.
  const [snoozedShelfExpanded, setSnoozedShelfExpanded] = useLocalStorage(
    SNOOZED_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const toggleSnoozedShelf = useCallback(
    () => setSnoozedShelfExpanded((value) => !value),
    [setSnoozedShelfExpanded],
  );
  const visibleSnoozedThreads = useMemo(() => {
    if (snoozedShelfExpanded) return snoozedThreads;
    // The open thread must never vanish behind the collapsed shelf: a
    // snoozed thread reached by route (deep link, open before snoozing
    // elsewhere) keeps its row — with highlight and wake affordance — same
    // exception the settled tail's "Show more" makes.
    if (routeThreadKey === null) return EMPTY_THREADS;
    const routeThread = snoozedThreads.find(
      (thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
    );
    return routeThread === undefined ? EMPTY_THREADS : [routeThread];
  }, [routeThreadKey, snoozedShelfExpanded, snoozedThreads]);

  // The Working shelf (beta) collapses the same way, with the same route
  // exception: sending a message folds the open thread into the shelf, and
  // its row must stay visible there.
  const [workingShelfExpanded, setWorkingShelfExpanded] = useLocalStorage(
    WORKING_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const toggleWorkingShelf = useCallback(
    () => setWorkingShelfExpanded((value) => !value),
    [setWorkingShelfExpanded],
  );
  const visibleWorkingThreads = useMemo(() => {
    if (workingShelfExpanded) return workingThreads;
    if (routeThreadKey === null) return EMPTY_THREADS;
    const routeThread = workingThreads.find(
      (thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
    );
    return routeThread === undefined ? EMPTY_THREADS : [routeThread];
  }, [routeThreadKey, workingShelfExpanded, workingThreads]);

  // Every listed chat's painting: list rows show it at their start, and with boxes on
  // each chat is a small painted square, grouped into what needs you, what is working
  // and the rest, each ranked by the needs-you model.
  const [sidebarLayout] = useSidebarLayout();
  const boxPresentations = useMemo(() => {
    const listed = [
      ...pinnedThreads,
      ...visibleActiveThreads,
      ...workingThreads,
      ...visibleSnoozedThreads,
      ...renderedSettledThreads,
    ];
    // Rows are memoized: an unchanged chat gets the same box object back, so boxes
    // don't re-render on every shell update while agents stream.
    const siblingShare = sessionBoxSiblingShare(listed.map((thread) => thread.title));
    const faces = sessionBoxFacesFor(listed);
    const now = Date.parse(`${nowMinute}:00.000Z`);
    const byKey = new Map<string, SessionBoxPresentation>();
    for (const thread of listed) {
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      const lastVisitedAt = resolveThreadLastVisitedAt(
        thread.lastVisitedAt,
        threadLastVisitedAtById[key],
      );
      byKey.set(
        key,
        sessionBoxConnectionPresentation(
          presentSessionBoxCached(thread, {
            now,
            siblingShare,
            face: faces.get(thread.id),
            compact: true,
            unseen: hasUnseenCompletion({ ...thread, lastVisitedAt }),
          }),
          presentationById.get(thread.environmentId)?.connection.phase,
        ),
      );
    }
    return byKey;
  }, [
    nowMinute,
    pinnedThreads,
    visibleActiveThreads,
    workingThreads,
    visibleSnoozedThreads,
    renderedSettledThreads,
    threadLastVisitedAtById,
    presentationById,
  ]);
  const sessionBoxes = useMemo(() => {
    if (sidebarLayout !== "boxes") return null;
    const byKey = boxPresentations;
    const groups = { needsYou: [], working: [], recent: [] } as Record<
      "needsYou" | "working" | "recent",
      Array<{ thread: EnvironmentThreadShell; box: SessionBoxPresentation; updatedAt: string }>
    >;
    for (const thread of [...visibleActiveThreads, ...workingThreads]) {
      const box = byKey.get(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)))!;
      const group =
        box.tone === "asking" ? "needsYou" : box.tone === "working" ? "working" : "recent";
      groups[group].push({ thread, box, updatedAt: thread.updatedAt });
    }
    for (const group of Object.values(groups)) group.sort(compareSessionBoxes);
    return { byKey, groups };
  }, [sidebarLayout, boxPresentations, visibleActiveThreads, workingThreads]);

  const { groups: discordGroups, sections: discordSections } = useMemo(() => {
    const sections = new Map<string, SidebarSection>();
    const entries: EnvironmentThreadShell[] = [];
    const append = (threads: readonly EnvironmentThreadShell[], section: SidebarSection) => {
      for (const thread of threads) {
        entries.push(thread);
        sections.set(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), section);
      }
    };
    append(pinnedThreads, "pinned");
    append(visibleActiveThreads, "active");
    append(workingThreads, "working");
    append(snoozedThreads, "snoozed");
    append(settledThreads.slice(0, settledVisibleCount), "settled");
    return {
      sections,
      groups: groupDiscordChannels(
        entries,
        machineEnvironments.map((machine) => machine.environmentId),
        machineForThread,
      ),
    };
  }, [
    pinnedThreads,
    visibleActiveThreads,
    workingThreads,
    snoozedThreads,
    settledThreads,
    settledVisibleCount,
    machineEnvironments,
    machineForThread,
  ]);
  const discordOrderedThreads = useMemo(
    () =>
      [...discordGroups].flatMap(([machine, entries]) =>
        collapsedDiscordCategories.includes(`${selectedChatTab}:${machine}`) ? [] : entries,
      ),
    [discordGroups, collapsedDiscordCategories, selectedChatTab],
  );
  const machineThreads = useMemo(
    () =>
      threads.filter(
        (thread) =>
          thread.archivedAt === null &&
          chatTabShowsThread(
            selectedChatTab,
            chatTabViews,
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          ),
      ),
    [threads, selectedChatTab, chatTabViews],
  );
  const machineCounts = useMemo(
    () =>
      machineAttentionCounts(
        machineThreads.map((thread) => ({
          ...thread,
          environmentId: machineForThread(thread),
          visitKey: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        })),
        threadLastVisitedAtById,
      ),
    [machineThreads, machineForThread, threadLastVisitedAtById],
  );
  const filterThreads = useMemo(
    () =>
      filterSidebarV2VisibleThreads(machineThreads, null).map((thread) => ({
        environmentId: machineForThread(thread),
      })),
    [machineThreads, machineForThread],
  );
  const machines = useMemo(
    () =>
      machineEnvironments.map((environment) => ({
        id: environment.environmentId,
        label: privateLabel("Computer", environment.environmentId, environment.label),
        kind: environmentMachineById.get(environment.environmentId) ?? ("server" as const),
        connected: environment.connection.phase === "connected",
        connecting:
          environment.connection.phase === "connecting" ||
          environment.connection.phase === "reconnecting",
        needsYou: machineCounts.get(environment.environmentId) ?? 0,
        unread: machineThreads.some(
          (thread) =>
            machineForThread(thread) === environment.environmentId &&
            threadIsUnread(thread, threadLastVisitedAtById),
        ),
      })),
    [
      machineEnvironments,
      privateLabel,
      environmentMachineById,
      machineCounts,
      machineThreads,
      machineForThread,
      threadLastVisitedAtById,
    ],
  );
  const discordServerViews = useMemo(
    () => discordServers(chatTabViews, threads, threadLastVisitedAtById),
    [chatTabViews, threads, threadLastVisitedAtById],
  );
  const selectedDiscordServer = chatTabViews.find((tab) => tab.key === selectedChatTab);
  const selectedMachine = machines.find((machine) => machine.id === selectedMachineId);
  const terminalEnvironmentId = terminalListEnvironmentId(
    selectedMachineId,
    primaryEnvironmentId,
    machineEnvironments.map((environment) => environment.environmentId),
    primaryPending,
  );
  const terminalMachine = machines.find((machine) => machine.id === terminalEnvironmentId);
  const terminalConfig =
    terminalEnvironmentId === null ? undefined : serverConfigs.get(terminalEnvironmentId);
  const machineFilterIds = new Set(
    showingTerminalSessions
      ? machines.map((machine) => machine.id)
      : filterThreads.map((thread) => thread.environmentId),
  );
  const showMachineFilter = machineFilterVisible(
    [...machineFilterIds].map((environmentId) => ({ environmentId })),
  );

  const orderedThreads = useMemo(
    () =>
      discordMode
        ? discordOrderedThreads
        : sessionBoxes !== null
          ? [
              ...pinnedThreads,
              ...sessionBoxes.groups.needsYou.map((entry) => entry.thread),
              ...sessionBoxes.groups.working.map((entry) => entry.thread),
              ...sessionBoxes.groups.recent.map((entry) => entry.thread),
              ...visibleSnoozedThreads,
              ...renderedSettledThreads,
            ]
          : [
              ...pinnedThreads,
              ...visibleActiveThreads,
              ...visibleWorkingThreads,
              ...visibleSnoozedThreads,
              ...renderedSettledThreads,
            ],
    [
      discordMode,
      discordOrderedThreads,
      sessionBoxes,
      pinnedThreads,
      visibleActiveThreads,
      visibleWorkingThreads,
      visibleSnoozedThreads,
      renderedSettledThreads,
    ],
  );
  const attentionOrderedThreads = useMemo(() => {
    if (discordMode) return [...discordGroups.values()].flat();
    const listed = new Set(orderedThreads);
    return [
      ...orderedThreads,
      ...activeThreads.filter((thread) => !listed.has(thread)),
      ...workingThreads.filter((thread) => !listed.has(thread)),
      ...snoozedThreads.filter((thread) => !listed.has(thread)),
      ...settledThreads.filter((thread) => !listed.has(thread)),
    ];
  }, [
    discordMode,
    discordGroups,
    orderedThreads,
    activeThreads,
    workingThreads,
    snoozedThreads,
    settledThreads,
  ]);
  const orderedThreadKeys = useMemo(
    () =>
      orderedThreads.map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
    [orderedThreads],
  );
  // Rows call back into the click handler without carrying the ordered list as
  // a prop — a fresh array identity per shell update would defeat every row's
  // memoization. The ref keeps shift-range-select working against the list as
  // rendered at click time.
  const orderedThreadKeysRef = useCommittedRef(orderedThreadKeys);
  const threadByKey = useMemo(
    () =>
      new Map(
        orderedThreads.map(
          (thread) =>
            [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
        ),
      ),
    [orderedThreads],
  );
  // Handlers read these through refs: depending on per-update Map/Set
  // identities would give every row a fresh callback prop on each shell
  // event and defeat row memoization during streaming.
  const threadByKeyRef = useCommittedRef(threadByKey);
  // handleNewThread is inherently unstable (depends on the projects list);
  // a ref keeps it out of attemptSettle's dependency array.
  const handleNewThreadRef = useCommittedRef(newThreadContext.handleNewThread);
  const settledThreadKeys = useMemo(
    () =>
      new Set(
        settledThreads.map((thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        ),
      ),
    [settledThreads],
  );
  const settledThreadKeysRef = useCommittedRef(settledThreadKeys);
  const snoozedThreadKeys = useMemo(
    () =>
      new Set(
        snoozedThreads.map((thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        ),
      ),
    [snoozedThreads],
  );
  const snoozedThreadKeysRef = useCommittedRef(snoozedThreadKeys);

  const jumpLabelByKey = useMemo(() => {
    const mapping = new Map<string, string>();
    for (const [index, threadKey] of orderedThreadKeys.entries()) {
      const jumpCommand = threadJumpCommandForIndex(index);
      if (!jumpCommand) break;
      const label = shortcutLabelForCommand(keybindings, jumpCommand);
      if (label) mapping.set(threadKey, label);
    }
    return mapping;
  }, [keybindings, orderedThreadKeys]);
  const { showThreadJumpHints: showJumpHints, updateThreadJumpHintsVisibility } =
    useThreadJumpHintVisibility();

  // Settled threads are live shells, so opening one is plain navigation:
  // history stays readable without un-settling, and sending a message or
  // starting a session un-settles server-side.
  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      setQuickFilter("all");
      if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(scopedThreadKey(threadRef));
      if (isMobile) {
        setOpenMobile(false);
      }
      return router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [clearSelection, isMobile, router, setOpenMobile, setSelectionAnchor],
  );

  const queuePendingFileDrop = useSidebarPendingFileDropStore((s) => s.queuePendingFileDrop);
  const clearPendingFileDrop = useSidebarPendingFileDropStore((s) => s.clearPendingFileDrop);
  const handleThreadFileDrop = useCallback(
    async (threadRef: ScopedThreadRef, files: File[]) => {
      const dropId = queuePendingFileDrop({ threadRef, files });
      const landedBefore =
        router.buildLocation({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        }).pathname === router.state.location.pathname;
      if (landedBefore) return;

      try {
        await navigateToThread(threadRef);
        const landed =
          router.buildLocation({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(threadRef),
          }).pathname === router.state.location.pathname;
        if (!landed) clearPendingFileDrop(dropId);
      } catch {
        clearPendingFileDrop(dropId);
      }
    },
    [clearPendingFileDrop, navigateToThread, queuePendingFileDrop, router],
  );

  const navigateToDraft = useCallback(
    (draftId: DraftId) => {
      // Unconditional: also drops a stale selection anchor left by
      // plain-click navigation, so a later shift-click starts fresh
      // instead of ranging from a row that is no longer the context.
      // (clearSelection no-ops when there is nothing to clear.)
      clearSelection();
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({ to: "/draft/$draftId", params: { draftId } });
    },
    [clearSelection, isMobile, router, setOpenMobile],
  );

  const clearThreadSearch = useCallback(() => {
    setThreadSearchQuery("");
    setQuickFilter("all");
    setActiveSearchResultIndex(0);
  }, []);
  const selectThreadSearchResult = useCallback(
    (thread: EnvironmentThreadShell | EnvironmentThreadSearchMatch) => {
      const id = "id" in thread ? thread.id : thread.threadId;
      const match = threadSearchMatchByKey.get(
        threadSearchMatchKey({ environmentId: thread.environmentId, threadId: id }),
      );
      if (match?.messageId) appAtomRegistry.set(pendingThreadSearchJumpAtom, match);
      // The search stays, so the other results are a click away; × or Esc clears it.
      navigateToThread(scopeThreadRef(thread.environmentId, id));
    },
    [navigateToThread, threadSearchMatchByKey],
  );
  const handleThreadSearchKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      // IME composition (Japanese/Chinese input) uses the same keys; committing
      // a candidate must not move the highlight or navigate away mid-compose.
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      if (event.key === "Escape" && isShowingThreadResults) {
        event.preventDefault();
        event.stopPropagation();
        clearThreadSearch();
        return;
      }
      if (!isShowingThreadResults) {
        if (event.key === "ArrowDown") {
          const firstRow = threadListRef.current?.querySelector<HTMLElement>(
            "[data-sidebar-thread-row]",
          );
          if (firstRow) {
            event.preventDefault();
            focusSidebarRow("Home", firstRow);
          }
        }
        return;
      }
      if (threadSearchResults.length === 0) return;
      const navigation = resolveSidebarSearchNavigation({
        key: event.key,
        index: activeSearchResultIndex,
        visibleCount: visibleThreadSearchResults.length,
        totalCount: threadSearchResults.length,
        pageSize: SESSION_LIST_PAGE_COUNT,
      });
      if (navigation !== null) {
        event.preventDefault();
        setSearchVisibleCount(navigation.visibleCount);
        setActiveSearchResultIndex(navigation.index);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const result = threadSearchResults[activeSearchResultIndex];
        if (result) selectThreadSearchResult(result);
      }
    },
    [
      activeSearchResultIndex,
      clearThreadSearch,
      isShowingThreadResults,
      selectThreadSearchResult,
      threadSearchResults,
      visibleThreadSearchResults.length,
    ],
  );

  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const renameStartTitleRef = useRef("");
  const readOpensPullRequestsInRightPanel = useStableCallback(() => routeThreadRef !== null);
  const startThreadRename = useCallback(
    (threadRef: ScopedThreadRef, title: string) => {
      if (privacy) return;
      if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
      setRenamingThreadKey(scopedThreadKey(threadRef));
      setRenamingTitle(title);
      renameStartTitleRef.current = title;
    },
    [privacy],
  );
  const cancelThreadRename = useCallback(() => setRenamingThreadKey(null), []);
  const commitThreadRename = useCallback(
    (threadRef: ScopedThreadRef, title: string, originalTitle: string) => {
      void (async () => {
        if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
        setRenamingThreadKey(null);
        const resolution = resolveRenameCommit({
          title,
          originalTitle,
          startTitle: renameStartTitleRef.current,
        });
        if (resolution.action === "reject-empty") {
          toastManager.add({ type: "warning", title: "Chat title cannot be empty" });
          return;
        }
        if (resolution.action === "noop") return;
        const result = await updateThreadMetadata({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, title: resolution.title },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to rename chat",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [updateThreadMetadata],
  );

  // Stable, so a navigation (which changes openBeside) re-renders no row.
  const handleThreadClick = useStableCallback(
    (event: ReactMouseEvent, threadRef: ScopedThreadRef) => {
      if (isSidebarNestedLinkClick(event.target)) return;
      const isMac = isMacPlatform(navigator.platform);
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const threadKey = scopedThreadKey(threadRef);
      // Option-click opens beside (as in VS Code); Cmd/Ctrl-click keeps toggling selection.
      if (event.altKey && !isModClick && !event.shiftKey) {
        event.preventDefault();
        void openBeside(threadRef);
        return;
      }
      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadKey);
        return;
      }
      if (event.shiftKey) {
        event.preventDefault();
        rangeSelectTo(threadKey, orderedThreadKeysRef.current);
        return;
      }
      if (isTrailingDoubleClick(event.detail)) {
        return;
      }
      navigateToThread(threadRef);
    },
  );

  // A settle per thread at a time: double clicks and repeated menu picks
  // must not dispatch a second settle that fails and toasts a false error.
  const settlingThreadKeysRef = useRef(new Set<string>());
  // Parking the thread you're looking at (settle or snooze) moves you
  // forward: the next remaining card (never a settled or snoozed row, never
  // one leaving in the same batch), or a fresh draft in this project when it
  // was the last active one. Callers snapshot the plan BEFORE the command
  // mutates the partition; background parks never navigate (null plan).
  const planForwardNavigation = useCallback(
    (threadKey: string, coParkingKeys?: ReadonlySet<string>): (() => void) | null => {
      if (routeThreadKeyRef.current !== threadKey) return null;
      const shell = threadByKeyRef.current.get(threadKey);
      const orderedKeys = orderedThreadKeysRef.current;
      const settledKeys = settledThreadKeysRef.current;
      const snoozedKeys = snoozedThreadKeysRef.current;
      const currentIndex = orderedKeys.indexOf(threadKey);
      const nextCardKey =
        currentIndex === -1
          ? null
          : ([...orderedKeys.slice(currentIndex + 1), ...orderedKeys.slice(0, currentIndex)].find(
              (key) => !settledKeys.has(key) && !snoozedKeys.has(key) && !coParkingKeys?.has(key),
            ) ?? null);
      const nextThread = nextCardKey ? threadByKeyRef.current.get(nextCardKey) : null;
      return nextThread
        ? () => navigateToThread(scopeThreadRef(nextThread.environmentId, nextThread.id))
        : shell
          ? () =>
              void handleNewThreadRef.current(scopeProjectRef(shell.environmentId, shell.projectId))
          : () => void router.navigate({ to: "/" });
    },
    [navigateToThread, router],
  );

  const attemptSettle = useCallback(
    (threadRef: ScopedThreadRef, opts: { coSettlingKeys?: ReadonlySet<string> } = {}) => {
      void (async () => {
        const threadKey = scopedThreadKey(threadRef);
        if (
          settlingThreadKeysRef.current.has(threadKey) ||
          pendingActionsStore.snapshot().has(threadKey)
        )
          return;
        settlingThreadKeysRef.current.add(threadKey);
        const navigateAfterSettle = planForwardNavigation(threadKey, opts.coSettlingKeys);
        const ticket = beginSidebarAction(threadRef, "settle");
        try {
          const result = await pendingActionsStore.run(ticket, () => settleThread(threadRef));
          if (result === null) return;
          if (result._tag === "Failure") {
            // Never navigate away from a thread that did not settle.
            if (!isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to settle chat",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          // Only move forward if the user is still on the settled thread —
          // a navigation made during the await wins over ours.
          if (
            shouldNavigateAfterThreadPark({
              threadKey,
              currentThreadKey: routeThreadKeyRef.current,
              action: "settle",
              now: new Date().toISOString(),
              thread: readThreadShell(threadRef),
            })
          ) {
            navigateAfterSettle?.();
          }
        } finally {
          settlingThreadKeysRef.current.delete(threadKey);
        }
      })();
    },
    [beginSidebarAction, pendingActionsStore, planForwardNavigation, settleThread],
  );
  // The thread.settle shortcut parks the open thread through this same path.
  useEffect(() => registerSettleAndAdvance(attemptSettle), [attemptSettle]);
  // Post-settle navigation must skip threads settling in this same batch —
  // they are all leaving the card block together. Rows that are already
  // explicitly settled are skipped: nothing to do on a valid mixed selection.
  // Pinned rows ARE included: the decider clears the pin as part of settling,
  // so they park like the rest.
  const settleThreads = useCallback(
    (threadKeys: readonly string[]) => {
      const coSettlingKeys = new Set(threadKeys);
      for (const threadKey of threadKeys) {
        const thread = threadByKeyRef.current.get(threadKey);
        if (!thread || thread.settledOverride === "settled") continue;
        attemptSettle(scopeThreadRef(thread.environmentId, thread.id), { coSettlingKeys });
      }
    },
    [attemptSettle],
  );
  const attemptUnsettle = useCallback(
    (threadRef: ScopedThreadRef) => {
      void (async () => {
        const ticket = beginSidebarAction(threadRef, "unsettle");
        const result = await pendingActionsStore.run(ticket, () => unsettleThread(threadRef));
        if (result === null) return;
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to un-settle chat",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [beginSidebarAction, pendingActionsStore, unsettleThread],
  );
  const attemptUnsnooze = useCallback(
    (threadRef: ScopedThreadRef) => {
      void (async () => {
        const ticket = beginSidebarAction(threadRef, "unsnooze");
        const result = await pendingActionsStore.run(ticket, () => unsnoozeThread(threadRef));
        if (result === null) return;
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to wake chat",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [beginSidebarAction, pendingActionsStore, unsnoozeThread],
  );
  const threadListRef = useRef<HTMLUListElement | null>(null);
  const dragLabelOffsetRef = useRef(0);
  const restrictBelowPins = useCallback<Modifier>(
    (args) => restrictBelowSidebarLabel(args, dragLabelOffsetRef.current),
    [],
  );
  const listMotionRef = useRef<ReturnType<typeof createSidebarListMotion> | null>(null);
  const attachListMotionRef = useCallback((node: HTMLUListElement | null) => {
    threadListRef.current = node;
    listMotionRef.current?.dispose();
    listMotionRef.current = node === null ? null : createSidebarListMotion(node);
    listMotionRef.current?.update(false);
  }, []);

  // Hold the chosen section and order until every key write arrives. This
  // also covers first-time ordering, which assigns keys to keyless neighbors.
  // A failed write, concurrent reorder, or membership change releases the hold.
  const [dragState, setDragState] = useState<{
    readonly activeKey: string;
    readonly activeSection: SidebarSection;
    readonly occurredAt: string;
    readonly activationY: number | null;
    readonly targetSection: SidebarSection | null;
    readonly contextDrag: boolean;
  } | null>(null);
  const isDraggingThread = dragState !== null;
  const isContextDrag = dragState?.contextDrag === true;
  const dragTargetSection = isContextDrag ? null : (dragState?.targetSection ?? null);
  const dragSensorRef = useRef<SidebarPointerSensor | null>(null);
  const contextDragKeyRef = useRef<string | null>(null);
  const finishThreadDrag = useCallback((started: boolean) => {
    dragSensorRef.current = null;
    contextDragKeyRef.current = null;
    setChatTabDropTarget(null);
    endThreadContextDrag();
    if (started) {
      listMotionRef.current?.release();
      setDragState(null);
    }
  }, []);
  const attachDragSensor = useCallback((sensor: SidebarPointerSensor) => {
    dragSensorRef.current = sensor;
  }, []);
  const cancelThreadDrag = useCallback(() => {
    dragSensorRef.current?.cancel();
  }, []);
  // Dragged threads: the multi-selection when the picked-up row is part of it.
  const contextDragThreads = useCallback((): ReadonlyArray<ScopedThreadRef> => {
    const key = contextDragKeyRef.current;
    if (key === null) return [];
    const selected = useThreadSelectionStore.getState().selectedThreadKeys;
    const keys = selected.has(key) ? [...selected] : [key];
    return keys.flatMap((candidate) => {
      const ref = parseScopedThreadKey(candidate);
      return ref ? [ref] : [];
    });
  }, []);
  const pointerOutsideThreadList = useCallback((point: { x: number; y: number }) => {
    const bounds = threadListRef.current?.getBoundingClientRect();
    return bounds !== undefined && (point.x < bounds.left || point.x > bounds.right);
  }, []);
  const moveThreadContextDrag = useCallback(
    (point: { x: number; y: number }) => {
      // Over a tab, the chat files into it on release.
      const overTab = chatTabDropAt(chatTabStripRef.current, point);
      setChatTabDropTarget(overTab);
      const contextDrag = overTab !== null || pointerOutsideThreadList(point);
      setDragState((current) =>
        current === null || current.contextDrag === contextDrag
          ? current
          : { ...current, contextDrag },
      );
      if (!contextDrag) {
        endThreadContextDrag();
        return false;
      }
      const threads = contextDragThreads();
      const title =
        threadByKeyRef.current.get(contextDragKeyRef.current ?? "")?.title.trim() || "Chat";
      moveThreadContextDragGhost(point, { title, count: threads.length });
      return true;
    },
    [contextDragThreads, pointerOutsideThreadList],
  );
  const dropThreadContextDrag = useCallback(
    (point: { x: number; y: number }) => {
      const overTab = chatTabDropAt(chatTabStripRef.current, point);
      if (overTab !== null) {
        const tab =
          overTab === ALL_CHATS_TAB
            ? null
            : chatTabViewsRef.current.find((candidate) => candidate.key === overTab);
        if (tab !== undefined) moveChatsToTab(contextDragThreads(), tab?.name ?? null);
        return true;
      }
      if (!pointerOutsideThreadList(point)) return false;
      dropThreadContext(point, contextDragThreads());
      // Releasing outside the list never reorders, whether or not a composer took the drop.
      return true;
    },
    [contextDragThreads, moveChatsToTab, pointerOutsideThreadList],
  );
  // One options object for the sidebar's life: dnd-kit rebuilds every row's
  // listeners, and so re-renders every row, whenever it changes.
  const onAttachDragSensor = useStableCallback(attachDragSensor);
  const onFinishThreadDrag = useStableCallback(finishThreadDrag);
  const onMoveThreadContextDrag = useStableCallback(moveThreadContextDrag);
  const onDropThreadContextDrag = useStableCallback(dropThreadContextDrag);
  const dragSensorOptions = useMemo(
    () => ({
      distance: SIDEBAR_DRAG_DISTANCE,
      onAttach: onAttachDragSensor,
      onFinish: onFinishThreadDrag,
      onMove: onMoveThreadContextDrag,
      onDrop: onDropThreadContextDrag,
    }),
    [onAttachDragSensor, onFinishThreadDrag, onMoveThreadContextDrag, onDropThreadContextDrag],
  );
  const dndSensors = useSensors(useSensor(SidebarPointerSensor, dragSensorOptions));
  const sectionByThreadKey = useMemo(() => {
    const map = new Map<string, SidebarSection>();
    const add = (list: readonly EnvironmentThreadShell[], section: SidebarSection) => {
      for (const thread of list) {
        map.set(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), section);
      }
    };
    add(pinnedThreads, "pinned");
    add(activeThreads, "active");
    add(workingThreads, "working");
    add(snoozedThreads, "snoozed");
    add(settledThreads, "settled");
    return map;
  }, [activeThreads, pinnedThreads, settledThreads, snoozedThreads, workingThreads]);
  const sectionByThreadKeyRef = useRef(sectionByThreadKey);
  sectionByThreadKeyRef.current = sectionByThreadKey;
  // Drag a row action to apply it to the armed rows in the same section.
  // Staying in one section keeps an overshoot from changing neighboring
  // sections, whose boundaries may be hidden outside a row drag. The sweep
  // runs on the row drag's sensor and ref, so unmounting the list cancels it.
  const [actionSweep, setActionSweep] = useState<{
    action: SidebarSweepAction;
    keys: ReadonlySet<string>;
  } | null>(null);
  const startActionSweep = useStableCallback(
    (threadRef: ScopedThreadRef, action: SidebarSweepAction, event: PointerEvent) => {
      const originKey = scopedThreadKey(threadRef);
      const originSection = sectionByThreadKeyRef.current.get(originKey);
      const canApply = (key: string) => {
        const thread = threadByKeyRef.current.get(key);
        const capabilities =
          thread && serverConfigs.get(thread.environmentId)?.environment.capabilities;
        return (
          thread !== undefined &&
          sectionByThreadKeyRef.current.get(key) === originSection &&
          (action === "unsnooze"
            ? capabilities?.threadSnooze === true
            : capabilities?.threadSettlement === true)
        );
      };
      let targetKey: string | null = null;
      let sweptKeys: string[] = [];
      const sweepTo = (key: string | null) => {
        if (key === null || key === targetKey) return;
        targetKey = key;
        sweptKeys = resolveSidebarSweepKeys(orderedThreadKeysRef.current, originKey, key, canApply);
        setActionSweep({ action, keys: new Set(sweptKeys) });
      };
      dragSensorRef.current = new SidebarPointerSensor({
        active: originKey,
        event,
        options: {
          distance: SIDEBAR_DRAG_DISTANCE,
          onAttach: () => {},
          onFinish: () => {
            dragSensorRef.current = null;
            setActionSweep(null);
          },
        },
        onPending: () => {},
        onStart: () => sweepTo(originKey),
        onMove: ({ y }) =>
          sweepTo(threadListRef.current && sidebarThreadKeyAtY(threadListRef.current, y)),
        // Also runs after a press that never moved. Nothing is swept then,
        // and the button's own click applies its action. Rows that changed
        // section mid-gesture, say pinned from another device, are skipped.
        onEnd: () => {
          const keys = sweptKeys.filter(canApply);
          if (action === "settle") {
            settleThreads(keys);
            return;
          }
          for (const key of keys) {
            const ref = parseScopedThreadKey(key);
            if (ref === null) continue;
            if (action === "unsettle") attemptUnsettle(ref);
            else attemptUnsnooze(ref);
          }
        },
        onCancel: () => {},
        onAbort: () => {},
      });
    },
  );
  const pinnedKeys = useMemo(
    () =>
      pinnedThreads.map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
    [pinnedThreads],
  );
  const activeKeys = useMemo(
    () =>
      activeThreads.map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
    [activeThreads],
  );
  const dropOptions = useMemo(
    () => ({
      activeLeadingKeys: new Set(
        (isDraggingThread ? threads : [])
          .filter((thread) => sidebarSessionNeedsYou(thread, Date.parse(`${nowMinute}:00.000Z`)))
          .map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
      ),
    }),
    [isDraggingThread, threads, nowMinute],
  );
  useEffect(() => {
    if (optimisticDrop === null || !optimisticDrop.commandsComplete) return;
    const canonicalByKey = new Map(
      threads.map((thread) => [
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        thread,
      ]),
    );
    const thread = canonicalByKey.get(optimisticDrop.key);
    if (thread === undefined || thread.archivedAt !== null) {
      setOptimisticDrop(null);
      return;
    }
    const canonicalSection = resolveSidebarThreadSection({
      snoozed: effectiveSnoozed(thread, { now: new Date().toISOString() }),
      settled: thread.settledOverride === "settled",
      pinned: thread.pinnedAt != null,
    });
    if (
      canonicalSection !== optimisticDrop.sourceSection &&
      canonicalSection !== optimisticDrop.section
    ) {
      setOptimisticDrop(null);
      return;
    }
    if (optimisticDrop.order === null) {
      // Settle also emits unpin/unsnooze events. Wait for the entire move
      // before releasing the projected fields and sort timestamps.
      if (
        canonicalSection === optimisticDrop.section &&
        thread.pinnedAt == null &&
        (!optimisticDrop.clearsSnooze || thread.snoozedUntil == null)
      ) {
        setOptimisticDrop(null);
      }
      return;
    }
    if (canonicalSection !== optimisticDrop.section) return;
    if (optimisticDrop.clearsSnooze && thread.snoozedUntil != null) return;
    const destinationKeys = optimisticDrop.section === "pinned" ? pinnedKeys : activeKeys;
    const canonicalDestination = destinationKeys.flatMap((key) => {
      const canonical = canonicalByKey.get(key);
      return canonical === undefined ? [] : [canonical];
    });
    const keyByThread = new Map(
      canonicalDestination.map((thread) => [
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        (optimisticDrop.section === "pinned" ? thread.pinOrderKey : thread.activeOrderKey) ?? null,
      ]),
    );
    const heldOrder = optimisticDrop.order;
    const heldKeys = new Set(heldOrder);
    const membershipChanged =
      destinationKeys.length !== heldOrder.length ||
      destinationKeys.some((key) => !heldKeys.has(key));
    const foreignKeyLanded = destinationKeys.some((threadKey) => {
      const currentKey = keyByThread.get(threadKey) ?? null;
      if (currentKey === (optimisticDrop.keysAtDrop.get(threadKey) ?? null)) return false;
      return currentKey !== optimisticDrop.assignedKeys.get(threadKey);
    });
    const allAssignmentsLanded = [...optimisticDrop.assignedKeys].every(
      ([threadKey, orderKey]) => keyByThread.get(threadKey) === orderKey,
    );
    if (membershipChanged || foreignKeyLanded || allAssignmentsLanded) {
      setOptimisticDrop(null);
    }
  }, [activeKeys, optimisticDrop, pinnedKeys, threads]);
  const attemptPin = useCallback(
    (threadRef: ScopedThreadRef) => {
      if (pendingActionsStore.snapshot().has(scopedThreadKey(threadRef))) return;
      void (async () => {
        // Fresh pins take the top of the arranged run: pinThread computes a
        // key before the smallest key across ALL pinned shells — including
        // snoozed pins hidden from this list, whose keys are still part of
        // the run — so the new pin can't land beneath a hidden head.
        const ticket = beginSidebarAction(threadRef, "pin");
        const result = await pendingActionsStore.run(ticket, () => pinThread(threadRef));
        if (result === null) return;
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to pin chat",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [beginSidebarAction, pendingActionsStore, pinThread],
  );
  const attemptUnpin = useCallback(
    (threadRef: ScopedThreadRef) => {
      void (async () => {
        const ticket = beginSidebarAction(threadRef, "unpin");
        const result = await pendingActionsStore.run(ticket, () =>
          confirmAndUnpinThread(threadRef),
        );
        if (result === null) return;
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to unpin chat",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [beginSidebarAction, confirmAndUnpinThread, pendingActionsStore],
  );

  const handleThreadDragStart = useCallback(
    (event: DragStartEvent) => {
      const activeKey = String(event.active.id);
      contextDragKeyRef.current = activeKey;
      const activeSection = sectionByThreadKey.get(activeKey);
      if (activeSection === undefined) return;
      // Stop normal section motion before dnd-kit measures the picked-up row.
      listMotionRef.current?.suspend();
      const list = threadListRef.current;
      const header = list?.querySelector<HTMLElement>('[data-testid="sidebar-pinned-header"]');
      if (list && header) {
        const listRect = list.getBoundingClientRect();
        const scale = list.offsetWidth > 0 ? listRect.width / list.offsetWidth : 1;
        dragLabelOffsetRef.current =
          header.getBoundingClientRect().top - listRect.top + SIDEBAR_DRAG_LABEL_HEIGHT * scale;
      } else {
        dragLabelOffsetRef.current = 0;
      }
      setDragState({
        activeKey,
        activeSection,
        targetSection: activeSection,
        contextDrag: false,
        occurredAt: new Date().toISOString(),
        activationY:
          event.activatorEvent instanceof PointerEvent ? event.activatorEvent.clientY : null,
      });
    },
    [sectionByThreadKey],
  );
  // Include every visible row in the measured order. Older servers disable
  // pickup on their rows without changing where those rows render.
  const sidebarListItems = useMemo((): readonly SidebarListItem[] => {
    const rowsOf = (
      list: readonly EnvironmentThreadShell[],
      section: SidebarSection,
    ): SidebarListItem[] =>
      list.map((thread) => {
        const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
        return { kind: "thread", key, section };
      });
    if (
      pinnedThreads.length +
        activeThreads.length +
        workingThreads.length +
        snoozedThreads.length +
        settledThreads.length ===
      0
    ) {
      return [];
    }
    const items: SidebarListItem[] = [{ kind: "marker", marker: "pinned-header" }];
    const pinnedRows = rowsOf(pinnedThreads, "pinned");
    items.push(...pinnedRows);
    items.push({ kind: "marker", marker: "pinned-divider" });
    const activeRows = rowsOf(visibleActiveThreads, "active");
    items.push({ kind: "marker", marker: "active-placeholder" });
    items.push(...activeRows);
    if (workingThreads.length > 0) {
      items.push({ kind: "marker", marker: "working-header" });
      items.push(...rowsOf(visibleWorkingThreads, "working"));
    }
    if (snoozedThreads.length > 0) {
      items.push({ kind: "marker", marker: "snoozed-header" });
      items.push(...rowsOf(visibleSnoozedThreads, "snoozed"));
    }
    if (settledThreads.length > 0) {
      items.push({ kind: "marker", marker: "settled-header" });
      items.push({ kind: "marker", marker: "settled-placeholder" });
      items.push(...rowsOf(renderedSettledThreads, "settled"));
    }
    return items;
  }, [
    activeThreads.length,
    isDraggingThread,
    pinnedThreads,
    renderedSettledThreads,
    settledThreads.length,
    snoozedThreads.length,
    visibleActiveThreads,
    visibleSnoozedThreads,
    visibleWorkingThreads,
    workingThreads.length,
  ]);
  useEffect(() => {
    if (
      dragState !== null &&
      !sidebarListItems.some((item) => item.kind === "thread" && item.key === dragState.activeKey)
    ) {
      cancelThreadDrag();
    }
  }, [cancelThreadDrag, dragState, sidebarListItems]);
  const listMotionPaused = dragState !== null;
  // Every shell event rebuilds sidebarListItems, but rows only move when the
  // rendered order or a row's section changes. Keying the motion pass on that
  // keeps ordinary updates from forcing a layout read and animating rows
  // whose position drifted for other reasons.
  const sidebarListOrderKey = useMemo(
    () =>
      sidebarListItems
        .map((item) => (item.kind === "thread" ? `${item.key}:${item.section}` : item.marker))
        .join("\0"),
    [sidebarListItems],
  );
  const sidebarListHasRows = sidebarListItems.length + visibleDraftSessionCount > 0;
  useLayoutEffect(() => {
    // Drag release clears the baseline, so its commit cannot replay the
    // sortable preview; rows glide from their released positions instead.
    // Later thread actions can animate while writes settle.
    // Draft navigation can reveal a frozen row without changing the draft count.
    void sidebarListOrderKey;
    listMotionRef.current?.update(!listMotionPaused && sidebarListHasRows);
  }, [
    listMotionPaused,
    routeDraftIdForRows,
    sidebarListHasRows,
    sidebarListOrderKey,
    visibleDraftSessionCount,
  ]);
  const handleThreadDragOver = useCallback(
    (event: DragOverEvent) => {
      const target = event.over
        ? resolveSidebarDropTarget(
            sidebarListItems,
            String(event.active.id),
            String(event.over.id),
            dropOptions,
          )
        : null;
      setDragState((current) =>
        current === null || current.activeKey !== String(event.active.id)
          ? current
          : { ...current, targetSection: target?.section ?? null },
      );
    },
    [dropOptions, sidebarListItems],
  );
  const nextSortableIds = useMemo(
    () => sidebarListItems.map(sidebarListItemId),
    [sidebarListItems],
  );
  // The same array while the ids are the same: dnd-kit takes a new one for a
  // reorder, re-rendering every row with its transition cut for a frame.
  const [keptSortableIds, setKeptSortableIds] = useState(nextSortableIds);
  const sortableIdsChanged =
    keptSortableIds.length !== nextSortableIds.length ||
    keptSortableIds.some((id, index) => id !== nextSortableIds[index]);
  if (sortableIdsChanged) setKeptSortableIds(nextSortableIds);
  const sortableIds = sortableIdsChanged ? nextSortableIds : keptSortableIds;
  const draggedSettledOrder = useMemo(() => {
    const thread = dragState === null ? undefined : threadByKey.get(dragState.activeKey);
    if (dragState === null || thread === undefined) return [];
    const key = (candidate: EnvironmentThreadShell) =>
      scopedThreadKey(scopeThreadRef(candidate.environmentId, candidate.id));
    return sortSettledThreads([
      ...settledThreads.filter((candidate) => key(candidate) !== dragState.activeKey),
      applySidebarThreadDrop(thread, "settled", dragState.occurredAt),
    ]).map(key);
  }, [dragState, settledThreads, threadByKey]);
  // The session list is time-ordered, so the preview shows the slot a drop
  // will land in, not the slot under the pointer.
  const draggedActiveOrder = useMemo(() => {
    const thread = dragState === null ? undefined : threadByKey.get(dragState.activeKey);
    if (dragState === null || thread === undefined) return undefined;
    const key = (candidate: EnvironmentThreadShell) =>
      scopedThreadKey(scopeThreadRef(candidate.environmentId, candidate.id));
    return sortSidebarSessions(
      [
        ...visibleActiveThreads.filter((candidate) => key(candidate) !== dragState.activeKey),
        applySidebarThreadDrop(thread, "active", dragState.occurredAt),
      ],
      { nowMs: Date.parse(`${nowMinute}:00.000Z`) },
    ).map(key);
  }, [dragState, nowMinute, threadByKey, visibleActiveThreads]);
  const sidebarSortingStrategy = useMemo(
    () =>
      createSidebarSortingStrategy({
        items: sidebarListItems,
        ...dropOptions,
        enabled: !isContextDrag,
        boundaryLabelHeight: SIDEBAR_DRAG_LABEL_HEIGHT,
        settledOrder: draggedSettledOrder,
        ...(draggedActiveOrder === undefined ? {} : { activeOrder: draggedActiveOrder }),
        settledExpanded: settledShelfExpanded,
        settledVisibleCount,
        routeThreadKey,
        snoozedThreadCount: snoozedThreads.length,
      }),
    [
      draggedActiveOrder,
      dropOptions,
      draggedSettledOrder,
      isContextDrag,
      routeThreadKey,
      settledShelfExpanded,
      settledVisibleCount,
      sidebarListItems,
      snoozedThreads.length,
    ],
  );
  // Hidden and filtered threads keep their keys. Reserve those slots without
  // including the rows in the visible drop order or writing to them.
  const { pinnedKeysById, activeKeysById } = useMemo(
    () => ({
      pinnedKeysById: new Map(
        threads.map((thread) => [
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          thread.pinOrderKey ?? null,
        ]),
      ),
      activeKeysById: new Map(
        threads.map((thread) => [
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          thread.activeOrderKey ?? null,
        ]),
      ),
    }),
    [threads],
  );
  const draggedThreadKey = dragState?.activeKey;
  const draggedFromSection = dragState?.activeSection;
  const dragActivationY = dragState?.activationY;
  const dndCollisionDetection = useMemo(() => {
    if (draggedThreadKey === undefined || draggedFromSection === undefined)
      return createSidebarCollisionDetection(() => true);
    const source = threadByKey.get(draggedThreadKey);
    if (source === undefined) return createSidebarCollisionDetection(() => false);
    return createSidebarCollisionDetection(
      (id) => {
        const target = resolveSidebarDropTarget(
          sidebarListItems,
          draggedThreadKey,
          id,
          dropOptions,
        );
        if (target === null) return false;
        return (
          planSidebarThreadDrop({
            activeKey: draggedThreadKey,
            activeSection: draggedFromSection,
            activePinned: source.pinnedAt != null,
            activeSettled: source.settledOverride === "settled",
            supportsSettlement:
              serverConfigs.get(source.environmentId)?.environment.capabilities.threadSettlement ===
              true,
            target,
            pinnedOrder: pinnedKeys,
            pinnedKeysById,
            reorderableKeys: draggableThreadKeys,
            activeOrder: activeKeys,
            activeKeysById,
            activeReorderableKeys: activeReorderableThreadKeys,
            activeTimeOrdered: true,
          }).kind !== "none"
        );
      },
      {
        items: sidebarListItems,
        activationY: dragActivationY ?? null,
      },
    );
  }, [
    activeKeysById,
    dropOptions,
    pinnedKeysById,
    serverConfigs,
    activeKeys,
    activeReorderableThreadKeys,
    draggedThreadKey,
    draggedFromSection,
    dragActivationY,
    draggableThreadKeys,
    pinnedKeys,
    sidebarListItems,
    threadByKey,
    workingShelfEnabled,
  ]);
  const handleThreadDragEnd = useCallback(
    (event: DragEndEvent) => {
      const activeKey = String(event.active.id);
      const activeSection = sectionByThreadKey.get(activeKey);
      const target =
        event.over === null
          ? null
          : resolveSidebarDropTarget(
              sidebarListItems,
              activeKey,
              String(event.over.id),
              dropOptions,
            );
      const activeThread = threadByKey.get(activeKey);
      if (activeSection === undefined || target === null || activeThread === undefined) return;
      const threadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
      const plan = planSidebarThreadDrop({
        activeKey,
        activeSection,
        activePinned: activeThread.pinnedAt != null,
        activeSettled: activeThread.settledOverride === "settled",
        supportsSettlement:
          serverConfigs.get(activeThread.environmentId)?.environment.capabilities
            .threadSettlement === true,
        target,
        pinnedOrder: pinnedKeys,
        pinnedKeysById,
        reorderableKeys: draggableThreadKeys,
        activeOrder: activeKeys,
        activeKeysById,
        activeReorderableKeys: activeReorderableThreadKeys,
        activeTimeOrdered: true,
      });
      if (plan.kind === "none") return;
      if (plan.kind === "settle" && settlingThreadKeysRef.current.has(activeKey)) return;
      const assignments =
        plan.kind === "pin"
          ? [
              ...(plan.orderKey === undefined ? [] : [{ id: activeKey, orderKey: plan.orderKey }]),
              ...plan.extraAssignments,
            ]
          : plan.kind === "reorder-pinned" || plan.kind === "move-active"
            ? plan.assignments
            : [];
      // A drop rewrites the dragged row and every row it renumbers, so all of
      // them must be writable before any of them changes.
      if (
        !checkThreadOperations(
          [activeKey, ...assignments.map(({ id }) => id)].flatMap((key) => {
            const thread = threadByKey.get(key);
            return thread ? [thread] : [];
          }),
        )
      )
        return;
      const drop = {
        key: activeKey,
        id: Symbol(),
        commandsComplete: true,
        sourceSection: activeSection,
        section: target.section,
        occurredAt: new Date().toISOString(),
        clearsSnooze:
          plan.kind === "pin" ||
          plan.kind === "settle" ||
          (plan.kind === "move-active" && plan.unsnooze),
        order: plan.kind === "settle" ? null : plan.order,
        keysAtDrop: target.section === "pinned" ? pinnedKeysById : activeKeysById,
        assignedKeys: new Map(assignments.map(({ id, orderKey }) => [id, orderKey])),
      };
      setOptimisticDrop(drop);
      void (async () => {
        const run = async (
          operation: Promise<AtomCommandResult<unknown, unknown>>,
          title: string,
        ) => {
          const result = await operation;
          if (result._tag === "Success") return true;
          // A late failure must not cancel a newer drag's preview.
          setOptimisticDrop((current) => (current === drop ? null : current));
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title,
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return false;
        };
        switch (plan.kind) {
          case "settle": {
            settlingThreadKeysRef.current.add(activeKey);
            const navigateAfterSettle = planForwardNavigation(activeKey);
            const settled = await run(settleThread(threadRef), "Failed to settle chat").finally(
              () => settlingThreadKeysRef.current.delete(activeKey),
            );
            setOptimisticDrop((current) =>
              current?.id === drop.id ? { ...current, commandsComplete: true } : current,
            );
            if (
              settled &&
              shouldNavigateAfterThreadPark({
                threadKey: activeKey,
                currentThreadKey: routeThreadKeyRef.current,
                action: "settle",
                now: new Date().toISOString(),
                thread: readThreadShell(threadRef),
              })
            )
              navigateAfterSettle?.();
            return;
          }
          case "move-active":
            // The drag expresses unpin intent; button/menu confirmation is unchanged.
            if (plan.unpin && !(await run(unpinThread(threadRef), "Failed to unpin chat"))) return;
            if (
              plan.unsettle &&
              !(await run(unsettleThread(threadRef), "Failed to un-settle chat"))
            )
              return;
            if (plan.unsnooze && !(await run(unsnoozeThread(threadRef), "Failed to wake chat")))
              return;
            break;
          case "pin":
            if (
              !(await run(
                pinThread(
                  threadRef,
                  plan.orderKey === undefined ? {} : { orderKey: plan.orderKey },
                ),
                "Failed to pin chat",
              ))
            )
              return;
            break;
          case "reorder-pinned":
            break;
        }
        // Stop on failure; each successful key write remains a valid placement.
        const keyWrites = plan.kind === "pin" ? plan.extraAssignments : plan.assignments;
        for (const assignment of keyWrites) {
          const thread = threadByKey.get(assignment.id);
          if (thread === undefined) continue;
          if (
            !(await run(
              (plan.kind === "move-active" ? reorderActiveThread : reorderPinnedThread)(
                scopeThreadRef(thread.environmentId, thread.id),
                assignment.orderKey,
              ),
              plan.kind === "move-active"
                ? "Failed to reorder active chats"
                : "Failed to reorder pinned chats",
            ))
          )
            return;
        }
      })();
    },
    [
      activeKeysById,
      dropOptions,
      pinnedKeysById,
      serverConfigs,
      activeKeys,
      activeReorderableThreadKeys,
      draggableThreadKeys,
      pinThread,
      pinnedKeys,
      planForwardNavigation,
      reorderPinnedThread,
      reorderActiveThread,
      sectionByThreadKey,
      settleThread,
      sidebarListItems,
      threadByKey,
      unpinThread,
      unsettleThread,
      unsnoozeThread,
      workingShelfEnabled,
    ],
  );
  // One snooze per thread at a time — same double-dispatch guard as settle.
  const snoozingThreadKeysRef = useRef(new Set<string>());
  const performSnooze = useCallback(
    async (
      threadRef: ScopedThreadRef,
      preset: Pick<SnoozePreset, "snoozedUntil">,
      opts: { coSnoozingKeys?: ReadonlySet<string> } = {},
    ) => {
      const threadKey = scopedThreadKey(threadRef);
      if (
        snoozingThreadKeysRef.current.has(threadKey) ||
        pendingActionsStore.snapshot().has(threadKey)
      ) {
        return { status: "skipped" } as const;
      }
      snoozingThreadKeysRef.current.add(threadKey);
      const navigateAfterSnooze = planForwardNavigation(threadKey, opts.coSnoozingKeys);
      const ticket = beginSidebarAction(threadRef, "snooze");
      try {
        // Snoozing the open thread moves you forward, same as settle —
        // both park the thread you're done with for now.
        const result = await pendingActionsStore.run(ticket, () =>
          snoozeThread(threadRef, preset.snoozedUntil),
        );
        if (result === null) return { status: "skipped" } as const;
        if (result._tag === "Failure") {
          // Never navigate away from a thread that did not snooze.
          return isAtomCommandInterrupted(result)
            ? ({ status: "interrupted" } as const)
            : ({ status: "failure", error: squashAtomCommandFailure(result) } as const);
        }
        // Only move forward if the user is still on the snoozed thread —
        // a navigation made during the await wins over ours.
        if (
          shouldNavigateAfterThreadPark({
            threadKey,
            currentThreadKey: routeThreadKeyRef.current,
            action: "snooze",
            now: new Date().toISOString(),
            thread: readThreadShell(threadRef),
          })
        ) {
          navigateAfterSnooze?.();
        }
        return { status: "success" } as const;
      } finally {
        snoozingThreadKeysRef.current.delete(threadKey);
      }
    },
    [beginSidebarAction, pendingActionsStore, planForwardNavigation, snoozeThread],
  );
  const attemptSnooze = useCallback(
    (
      threadRef: ScopedThreadRef,
      preset: Pick<SnoozePreset, "snoozedUntil">,
      opts: { coSnoozingKeys?: ReadonlySet<string> } = {},
    ) => {
      void (async () => {
        const outcome = await performSnooze(threadRef, preset, opts);
        if (outcome.status === "failure") {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to snooze chat",
              description:
                outcome.error instanceof Error ? outcome.error.message : "An error occurred.",
            }),
          );
          return;
        }
      })();
    },
    [performSnooze],
  );

  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const handleMultiSelectContextMenu = useStableCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      // One exact actionable set: keys whose rows are actually rendered
      // right now. Selections can outlive their rows (settled-tail paging,
      // thread deletion elsewhere) and the menu labels must count only what
      // the actions will touch.
      const selectedThreadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys];
      const threadKeys = selectedThreadKeys.filter((threadKey) =>
        threadByKeyRef.current.has(threadKey),
      );
      if (threadKeys.length === 0) return;
      const count = threadKeys.length;
      // Snooze (N) is offered when every selected thread can actually take
      // it — a mixed selection with blocked-on-you work would half-apply.
      const selectionNow = new Date();
      const selectedThreads = threadKeys.flatMap((threadKey) => {
        const thread = threadByKeyRef.current.get(threadKey);
        return thread ? [thread] : [];
      });
      const settlingThreads = selectedThreads.filter(
        (thread) => thread.settledOverride !== "settled",
      );
      const canSnoozeSelection = selectedThreads.every(
        (thread) =>
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze === true &&
          canSnooze(thread, { now: selectionNow.toISOString() }),
      );
      const titleRegenerationThreads = selectedThreads.filter(
        (thread) =>
          serverConfigs.get(thread.environmentId)?.environment.capabilities
            .threadTitleRegeneration === true,
      );
      const regeneratableTitleThreads = titleRegenerationThreads.filter(
        (thread) => thread.titleRegeneration == null,
      );
      const titleRegenerationMenuItem = buildBulkTitleRegenerationContextMenuItem({
        supportedCount: titleRegenerationThreads.length,
        actionableCount: regeneratableTitleThreads.length,
      });
      // Unpin (k) counts only the pinned rows in pin-capable environments —
      // on a mixed selection the unpinned rows are untouched, and the item
      // is omitted entirely when nothing selected is pinned.
      const pinnedSelectedThreads = selectedThreads.filter(
        (thread) =>
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadPinning ===
            true && thread.pinnedAt != null,
      );
      const unpinMenuItem = buildBulkUnpinContextMenuItem({
        pinnedCount: pinnedSelectedThreads.length,
      });
      const snoozePresets = resolveSnoozePresets(new Date(), timestampFormat);
      const tabMenuItem = chatTabMenuFor(selectedThreads, count);
      const clicked = await settlePromise(() =>
        api.contextMenu.show(
          [
            ...(unpinMenuItem
              ? [{ ...unpinMenuItem, disabled: !canOperateThreads(pinnedSelectedThreads) }]
              : []),
            {
              id: "settle",
              label: `Settle (${count})`,
              disabled: settlingThreads.length === 0 || !canOperateThreads(settlingThreads),
            },
            ...(canSnoozeSelection
              ? [
                  {
                    id: "snooze",
                    label: `Snooze (${count})`,
                    disabled: !canOperateThreads(selectedThreads),
                    children: [
                      ...snoozePresets.map((preset) => ({
                        id: `snooze:${preset.id}`,
                        label: `${preset.label} (${preset.whenLabel})`,
                        disabled: !canOperateThreads(selectedThreads),
                      })),
                      {
                        id: "snooze:custom",
                        label: "Custom…",
                        separatorBefore: true,
                        disabled: !canOperateThreads(selectedThreads),
                      },
                    ],
                  },
                ]
              : []),
            ...(titleRegenerationMenuItem
              ? [
                  {
                    ...titleRegenerationMenuItem,
                    disabled:
                      titleRegenerationMenuItem.disabled ||
                      !canOperateThreads(regeneratableTitleThreads),
                  },
                ]
              : []),
            ...(tabMenuItem === null
              ? []
              : [{ ...tabMenuItem, disabled: !canOperateThreads(selectedThreads) }]),
            { id: "mark-unread", label: `Mark unread (${count})` },
            {
              id: "delete",
              label: `Delete (${count})`,
              destructive: true,
              disabled: !canOperateThreads(selectedThreads),
            },
          ],
          position,
        ),
      );
      if (clicked._tag === "Failure" || clicked.value === null) return;
      if (isChatTabMenuId(clicked.value)) {
        if (checkThreadOperations(selectedThreads)) {
          pickChatTabMenu(
            selectedThreads.map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
            clicked.value,
            selectedThreads[0]?.title ?? "",
          );
        }
        return;
      }
      const actionTargets =
        clicked.value === "unpin"
          ? pinnedSelectedThreads
          : clicked.value === "regenerate-title"
            ? regeneratableTitleThreads
            : clicked.value === "settle"
              ? settlingThreads.flatMap((thread) => {
                  const current = threadByKeyRef.current.get(
                    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
                  );
                  return current && current.settledOverride !== "settled" ? [current] : [];
                })
              : selectedThreads;
      if (clicked.value === "settle" && actionTargets.length === 0) return;
      if (clicked.value !== "mark-unread" && !checkThreadOperations(actionTargets)) return;
      if (clicked.value?.startsWith("snooze:")) {
        const preset =
          clicked.value === "snooze:custom"
            ? await requestCustomSnooze()
            : snoozePresets.find((candidate) => `snooze:${candidate.id}` === clicked.value);
        if (preset) {
          // Post-snooze navigation must skip threads snoozing in this same
          // batch — they are all leaving the card block together.
          const coSnoozingKeys = new Set(threadKeys);
          clearSelection();
          const outcomes = await Promise.all(
            selectedThreads.map(async (thread) => {
              const threadRef = scopeThreadRef(thread.environmentId, thread.id);
              const outcome = await performSnooze(threadRef, preset, { coSnoozingKeys });
              return { outcome, threadRef };
            }),
          );
          const snoozedThreadRefs = outcomes.flatMap(({ outcome, threadRef }) =>
            outcome.status === "success" ? [threadRef] : [],
          );
          const failures = outcomes.flatMap(({ outcome }) =>
            outcome.status === "failure" ? [outcome.error] : [],
          );

          if (failures.length > 0) {
            const firstError = failures[0];
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title:
                  snoozedThreadRefs.length > 0
                    ? `Failed to snooze ${failures.length} chat${failures.length === 1 ? "" : "s"}`
                    : "Failed to snooze chats",
                description:
                  firstError instanceof Error ? firstError.message : "An error occurred.",
              }),
            );
          }
        }
        return;
      }
      if (clicked.value === "unpin") {
        // Each unpin reports its own failure, like the single-row action.
        for (const thread of pinnedSelectedThreads) {
          attemptUnpin(scopeThreadRef(thread.environmentId, thread.id));
        }
        clearSelection();
        return;
      }
      if (clicked.value === "regenerate-title") {
        for (const thread of regeneratableTitleThreads) {
          const result = await updateThreadMetadata({
            environmentId: thread.environmentId,
            input: { threadId: thread.id, regenerateTitle: true },
          });
          if (result._tag === "Success") continue;
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to regenerate chat titles",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
        clearSelection();
        return;
      }
      if (clicked.value === "settle") {
        settleThreads(
          actionTargets.map((thread) =>
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          ),
        );
        clearSelection();
        return;
      }
      if (clicked.value === "mark-unread") {
        for (const threadKey of threadKeys) {
          const thread = threadByKeyRef.current.get(threadKey);
          if (thread) markThreadUnread(scopeThreadRef(thread.environmentId, thread.id));
        }
        clearSelection();
        return;
      }
      if (clicked.value !== "delete") return;
      if (confirmThreadDelete) {
        const confirmed = await settlePromise(() =>
          api.dialogs.confirm(
            [
              `Delete ${count} chat${count === 1 ? "" : "s"}?`,
              "This permanently clears conversation history for these chats.",
            ].join("\n"),
            { variant: "destructive" },
          ),
        );
        if (confirmed._tag === "Failure" || !confirmed.value) return;
      }
      if (
        !checkThreadOperations(
          threadKeys.flatMap((threadKey) => {
            const thread = threadByKeyRef.current.get(threadKey);
            return thread ? [thread] : [];
          }),
        )
      )
        return;
      const { deletedThreadKeys, firstFailure } = await deleteSelectedThreadEntries({
        entries: threadKeys.map((threadKey) => ({ threadKey })),
        delete: async ({ threadKey }, deletedThreadKeys) => {
          const thread = threadByKeyRef.current.get(threadKey);
          if (!thread) return null;
          return deleteThread(scopeThreadRef(thread.environmentId, thread.id), {
            deletedThreadKeys,
          });
        },
      });
      if (firstFailure !== null) {
        const firstError = squashAtomCommandFailure(firstFailure);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to delete chats",
            description: firstError instanceof Error ? firstError.message : "An error occurred.",
          }),
        );
      }
      removeFromSelection(
        getThreadKeysToDeselectAfterDelete(selectedThreadKeys, deletedThreadKeys, (threadKey) => {
          const threadRef = parseScopedThreadKey(threadKey);
          return threadRef !== null && readThreadShell(threadRef) !== null;
        }),
      );
    },
  );

  const handleDraftContextMenu = useStableCallback(
    (draftId: DraftId, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        const session = useComposerDraftStore.getState().getDraftSession(draftId);
        if (!api || !session || session.promotedTo) return;
        const projectGroup = projectGroupsRef.current.find((group) =>
          group.memberProjectRefs.some(
            (ref) =>
              ref.environmentId === session.environmentId && ref.projectId === session.projectId,
          ),
        );
        const workspacePath =
          session.worktreePath ??
          projectByKey.get(`${session.environmentId}:${session.projectId}`)?.workspaceRoot;
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            buildDraftActionMenuItems({
              hasPath: Boolean(workspacePath),
              hasBranch: Boolean(session.branch),
              hasProject: projectGroup != null,
            }),
            position,
          ),
        );
        if (clicked._tag === "Failure") return;
        switch (clicked.value) {
          case "project-settings":
            if (projectGroup)
              openProjectSettings(projectGroup, {
                environmentId: session.environmentId,
                projectId: session.projectId,
              });
            return;
          case "copy-path":
            if (workspacePath) copyPathToClipboard(workspacePath, { path: workspacePath });
            return;
          case "copy-branch":
            if (session.branch) copyBranchToClipboard(session.branch, { branch: session.branch });
            return;
          case "discard": {
            // The menu can stay open while the draft sends; discarding a
            // promoting draft would strand the send.
            const current = useComposerDraftStore.getState().getDraftSession(draftId);
            if (current && !current.promotedTo) discardComposerDraft(draftId);
            return;
          }
        }
      })();
    },
  );

  const handleThreadContextMenu = useStableCallback(
    (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const threadKey = scopedThreadKey(threadRef);
        const selectionState = useThreadSelectionStore.getState();
        if (selectionState.hasSelection() && selectionState.selectedThreadKeys.has(threadKey)) {
          await handleMultiSelectContextMenu(position);
          return;
        }
        const thread = threadByKeyRef.current.get(threadKey);
        if (!thread) return;
        const threadWorkspacePath =
          thread.worktreePath ??
          projectByKey.get(`${thread.environmentId}:${thread.projectId}`)?.workspaceRoot ??
          null;
        // Environments without the settlement capability get no lifecycle
        // items at all.
        const supportsSettlement =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSettlement ===
          true;
        const supportsSnooze =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze === true;
        const supportsPinning =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadPinning === true;
        const supportsAutoSettleOptOut =
          serverConfigs.get(thread.environmentId)?.environment.capabilities
            .threadAutoSettleOptOut === true;
        const supportsTitleRegeneration =
          serverConfigs.get(thread.environmentId)?.environment.capabilities
            .threadTitleRegeneration === true;
        const isRegeneratingTitle = thread.titleRegeneration != null;
        const isSettled = settledThreadKeysRef.current.has(threadKey);
        const isSnoozed = snoozedThreadKeysRef.current.has(threadKey);
        const isPinned = thread.pinnedAt != null;
        // Presets resolve at menu-open time (same as the popover).
        const snoozePresets = resolveSnoozePresets(new Date(), timestampFormat);
        const threadProjectGroup =
          projectGroupsRef.current.find((project) =>
            project.memberProjectRefs.some(
              (projectRef) =>
                projectRef.environmentId === thread.environmentId &&
                projectRef.projectId === thread.projectId,
            ),
          ) ?? null;
        const actionItems = buildThreadActionMenuItems({
          canOperate: readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope),
          branch: thread.branch ?? null,
          projectFilter: null,
          hasProject: projectDisplayNameByKeyRef.current.has(
            `${thread.environmentId}:${thread.projectId}`,
          ),
          isPinned,
          isSettled,
          autoSettleEnabled: thread.autoSettleDisabledAt == null,
          isSnoozed,
          canSnoozeNow: canSnooze(thread, { now: new Date().toISOString() }),
          isRegeneratingTitle,
          isRunning: !threadRuntimeCanArchive(thread.runtime),
          supports: {
            settlement: supportsSettlement,
            autoSettleOptOut: supportsAutoSettleOptOut,
            snooze: supportsSnooze,
            pinning: supportsPinning,
            titleRegeneration: supportsTitleRegeneration,
          },
          snoozePresets,
        });
        // "Move to tab" closes the group of actions that change where the chat sits.
        const tabItem = chatTabMenuFor([thread]);
        const renameAt = actionItems.findIndex((item) => item.id === "rename");
        const menuItems: ReadonlyArray<ContextMenuItem<ThreadActionMenuId | ChatTabMenuId>> =
          tabItem === null
            ? actionItems
            : renameAt === -1
              ? [...actionItems, tabItem]
              : [...actionItems.slice(0, renameAt), tabItem, ...actionItems.slice(renameAt)];
        const clicked = await settlePromise(() =>
          api.contextMenu.show<ThreadActionMenuId | ChatTabMenuId | "open-beside">(
            [
              ...(routeThreadRef &&
              isSplittableChat(routeThreadRef) &&
              isSplittableChat(threadRef) &&
              scopedThreadKey(routeThreadRef) !== threadKey
                ? [{ id: "open-beside" as const, label: "Open beside" }]
                : []),
              ...menuItems,
            ],
            position,
          ),
        );
        if (clicked._tag === "Failure" || clicked.value === null) return;
        if (clicked.value === "open-beside") {
          await openBeside(threadRef);
          return;
        }
        if (isChatTabMenuId(clicked.value)) {
          if (checkThreadOperations([thread])) {
            pickChatTabMenu([threadRef], clicked.value, thread.title);
          }
          return;
        }
        if (threadActionRequiresOperate(clicked.value) && !checkThreadOperations([thread])) return;
        if (clicked.value?.startsWith("snooze:")) {
          const preset =
            clicked.value === "snooze:custom"
              ? await requestCustomSnooze()
              : snoozePresets.find((candidate) => `snooze:${candidate.id}` === clicked.value);
          if (preset) attemptSnooze(threadRef, preset);
          return;
        }
        switch (clicked.value) {
          case "project-settings":
            if (threadProjectGroup)
              openProjectSettings(threadProjectGroup, {
                environmentId: threadRef.environmentId,
                projectId: thread.projectId,
              });
            return;
          case "new-thread-on-branch": {
            // Explicit branch carry-over: reuse the thread's worktree when it
            // has one, otherwise its branch on the local checkout.
            const result = await settlePromise(() =>
              handleNewThreadRef.current(scopeProjectRef(thread.environmentId, thread.projectId), {
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                envMode: thread.worktreePath ? "worktree" : "local",
                startFromOrigin: false,
              }),
            );
            if (result._tag === "Failure") {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Could not create chat",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "settle":
            attemptSettle(threadRef);
            return;
          case "unsettle":
            attemptUnsettle(threadRef);
            return;
          case "unsnooze":
            attemptUnsnooze(threadRef);
            return;
          case "pin":
            attemptPin(threadRef);
            return;
          case "unpin":
            attemptUnpin(threadRef);
            return;
          case "auto-settle:enabled":
          case "auto-settle:disabled": {
            const result = await setThreadAutoSettle(
              threadRef,
              clicked.value === "auto-settle:enabled",
            );
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to update auto-settle",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "rename":
            startThreadRename(threadRef, thread.title);
            return;
          case "regenerate-title": {
            if (isRegeneratingTitle) return;
            const result = await updateThreadMetadata({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId, regenerateTitle: true },
            });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to regenerate chat title",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "mark-unread":
            markThreadUnread(threadRef);
            return;
          case "copy-path":
            if (!threadWorkspacePath) {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Path unavailable",
                  description: "This chat does not have a workspace path to copy.",
                }),
              );
              return;
            }
            copyPathToClipboard(threadWorkspacePath, { path: threadWorkspacePath });
            return;
          case "copy-branch":
            if (thread.branch) {
              copyBranchToClipboard(thread.branch, { branch: thread.branch });
            }
            return;
          case "copy-thread-id":
            copyThreadIdToClipboard(thread.id, { threadId: thread.id });
            return;
          case "archive": {
            if (confirmThreadArchive) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(
                  `Archive chat "${privateLabel("Chat", thread.id, thread.title)}"?`,
                ),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            let didArchive = false;
            const result = await archiveThread(threadRef, {
              onArchived: () => {
                didArchive = true;
              },
            });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: didArchive
                    ? "Chat archived, but navigation failed"
                    : "Failed to archive chat",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
              return;
            }
            return;
          }
          case "delete": {
            if (confirmThreadDelete) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(
                  [
                    `Delete chat "${privateLabel("Chat", thread.id, thread.title)}"?`,
                    "This permanently clears conversation history for this chat.",
                  ].join("\n"),
                  { variant: "destructive" },
                ),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            const result = await deleteThread(threadRef);
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to delete chat",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
              return;
            }
            return;
          }
          default:
            return;
        }
      })();
    },
  );

  // Thread jump (cmd+1..9) and prev/next traversal reuse the same commands as
  // v1 — the keybinding layer is shared, only the ordered list differs.
  const routeTerminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen() || isModelPickerOpen()) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: {
          terminalFocus: isTerminalFocused(),
          composerFocus: document.activeElement?.getAttribute("data-testid") === "composer-editor",
          terminalOpen: routeTerminalOpen,
          modelPickerOpen: isModelPickerOpen(),
          isWeb: !isElectron,
          isDesktop: isElectron,
        },
      });
      const navigateToThreadKey = (targetThreadKey: string | null) => {
        if (!targetThreadKey) return false;
        const targetThread =
          threadByKey.get(targetThreadKey) ??
          attentionOrderedThreads.find(
            (thread) =>
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === targetThreadKey,
          );
        if (!targetThread) return false;
        event.preventDefault();
        event.stopPropagation();
        navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
        return true;
      };
      const attentionDirection =
        command === "thread.nextUnread"
          ? "next"
          : command === "thread.previousUnread"
            ? "previous"
            : null;
      if (attentionDirection !== null) {
        const candidates = new Set(
          attentionOrderedThreads
            .filter(
              (thread) =>
                threadNeedsYouCount(
                  thread,
                  threadLastVisitedAtById[
                    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
                  ],
                ) > 0 || threadIsUnread(thread, threadLastVisitedAtById),
            )
            .map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
        );
        const target = nextAttentionThreadKey(
          attentionOrderedThreads.map((thread) =>
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          ),
          candidates,
          routeThreadKey,
          attentionDirection,
        );
        if (target && discordMode) {
          const category = [...discordGroups.keys()].find((category) =>
            (discordGroups.get(category) ?? []).some(
              (thread) =>
                scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === target,
            ),
          );
          if (category)
            setCollapsedDiscordCategories((categories) =>
              categories.filter((entry) => entry !== `${selectedChatTab}:${category}`),
            );
        }
        navigateToThreadKey(target);
        return;
      }
      if (
        discordMode &&
        event.altKey &&
        !event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !isTerminalFocused() &&
        (event.key === "ArrowUp" || event.key === "ArrowDown")
      ) {
        // Alt+Up still edits a queued message while the composer has focus.
        if (command === "thread.editQueuedMessage") return;
        navigateToThreadKey(
          resolveAdjacentThreadId({
            threadIds: orderedThreadKeys,
            currentThreadId: routeThreadKey,
            direction: event.key === "ArrowUp" ? "previous" : "next",
          }),
        );
        return;
      }
      const traversalDirection = threadTraversalDirectionFromCommand(command);
      if (traversalDirection !== null) {
        navigateToThreadKey(
          resolveAdjacentThreadId({
            threadIds: orderedThreadKeys,
            currentThreadId: routeThreadKey,
            direction: traversalDirection,
          }),
        );
        return;
      }
      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) return;
      navigateToThreadKey(orderedThreadKeys[jumpIndex] ?? null);
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [
    keybindings,
    navigateToThread,
    orderedThreadKeys,
    attentionOrderedThreads,
    discordGroups,
    selectedChatTab,
    setCollapsedDiscordCategories,
    threadLastVisitedAtById,
    discordMode,
    routeTerminalOpen,
    routeThreadKey,
    threadByKey,
  ]);

  // Same predicate as v1: hints show only while the held modifiers exactly
  // match a thread-jump binding. Adding Shift (screenshots) or Alt no
  // longer matches ⌘1..9, so the overlay hides for chords like ⌘⇧4.
  const shortcutModifiers = useShortcutModifierState();
  const terminalFocused = useTerminalFocus();
  const shouldShowJumpHintsNow = shouldShowThreadJumpHintsForModifiers(
    shortcutModifiers,
    keybindings,
    {
      platform: navigator.platform,
      context: {
        terminalFocus: terminalFocused,
        terminalOpen: routeTerminalOpen,
        modelPickerOpen: isModelPickerOpen(),
        isWeb: !isElectron,
        isDesktop: isElectron,
      },
    },
  );
  useEffect(() => {
    updateThreadJumpHintsVisibility(shouldShowJumpHintsNow);
  }, [shouldShowJumpHintsNow, updateThreadJumpHintsVisibility]);

  // New chat starts without a project, like Claude Code and Codex. Shift+click
  // starts in the current thread's project instead, and environments without
  // a scratch folder fall back to the project picker.
  const handleNewThreadClick = useCallback(
    (event?: ReactMouseEvent) => {
      if (isMobile) setOpenMobile(false);
      const inCurrentProject = event?.shiftKey ?? false;
      const scratchTargetEnvironmentId = inCurrentProject
        ? null
        : scratchEnvironmentId(
            selectedMachine?.id ??
              newThreadContext.activeThread?.environmentId ??
              newThreadContext.activeDraftThread?.environmentId ??
              primaryEnvironmentId,
          );
      if (scratchTargetEnvironmentId !== null) {
        void startScratchThread(scratchTargetEnvironmentId);
        return;
      }
      if (shouldCreateNewThreadInCurrentProject(inCurrentProject, projectGroups.length)) {
        void startNewThreadFromContext({
          activeDraftThread: newThreadContext.activeDraftThread,
          activeThread: newThreadContext.activeThread ?? undefined,
          defaultProjectRef: newThreadContext.defaultProjectRef,
          handleNewThread: newThreadContext.handleNewThread,
        });
        return;
      }
      openCommandPalette({ open: "new-thread-in" });
    },
    [
      isMobile,
      newThreadContext,
      primaryEnvironmentId,
      projectGroups.length,
      scratchEnvironmentId,
      selectedMachine,
      setOpenMobile,
      startScratchThread,
    ],
  );
  const newThreadShortcutLabel = shortcutLabelForCommand(keybindings, "chat.new");
  // Until every environment's chat list has arrived, an empty list means
  // "not loaded yet", not "no chats".
  const shellsBootstrapped = useAllEnvironmentShellsBootstrapped();
  return (
    <div className={discordMode ? "dc-shell" : "contents"} data-electron={isElectron}>
      {discordMode ? (
        <DiscordServerRail
          servers={discordServerViews}
          selected={selectedChatTab}
          onSelect={(key) => {
            setChatTabSelection(key);
            if (key !== CLAUDE_RC_TAB) setMachineSelection("all");
          }}
          home={{
            unread: threads.some((thread) => threadIsUnread(thread, threadLastVisitedAtById)),
            needsYou: [...machineAttentionCounts(threads, threadLastVisitedAtById).values()].reduce(
              (total, count) => total + count,
              0,
            ),
          }}
          onCreate={() => setDiscordServerSettings({ tab: null })}
          onContextMenu={(tab, position) => void handleChatTabContextMenu(tab, position)}
          dropTarget={chatTabDropTarget}
          ref={chatTabStripRef}
          canCreate={[...serverConfigs].some(
            ([id, config]) =>
              config.chatTabs !== undefined &&
              readEnvironmentScope(id, AuthOrchestrationOperateScope),
          )}
        />
      ) : null}
      {discordMode && discordServerSettings ? (
        <DiscordServerSettings
          key={discordServerSettings.tab?.key ?? "new-server"}
          tab={discordServerSettings.tab}
          initialName={discordServerSettings.suggestedName}
          onClose={() => setDiscordServerSettings(null)}
          onSave={async (name, icon) => {
            const tab = discordServerSettings.tab;
            if (
              chatTabViews.some((other) => other.key === chatTabKey(name) && other.key !== tab?.key)
            ) {
              toastManager.add({
                type: "warning",
                title: "A server with that name already exists",
              });
              return false;
            }
            const environments = tab
              ? chatTabEnvironments(tab)
              : [...serverConfigs.keys()].filter(
                  (id) =>
                    serverConfigs.get(id)?.chatTabs !== undefined &&
                    readEnvironmentScope(id, AuthOrchestrationOperateScope) &&
                    presentationById.get(id)?.connection.phase === "connected",
                );
            const saved = await sendChatTabsCommand(
              environments,
              tab ? { action: "rename", tab: tab.name, to: name } : { action: "create", tab: name },
            );
            if (!saved) return false;
            setChatTabSelection(chatTabKey(name));
            if (
              icon !== undefined &&
              !(await sendChatTabsCommand(
                environments.filter((id) => serverConfigs.get(id)?.chatTabs !== undefined),
                { action: "set-icon", tab: name, icon },
              ))
            )
              return false;
            return (
              tab !== null ||
              discordServerSettings.threads === undefined ||
              (await moveChatsToTab(discordServerSettings.threads, name))
            );
          }}
        />
      ) : null}
      <div className={discordMode ? "dc-channel-column" : "contents"}>
        <ThreadContextDragGhost />
        {discordMode ? (
          <DiscordMachineHeader
            server={selectedDiscordServer}
            terminal={showingTerminalSessions}
            onSettings={() =>
              selectedDiscordServer && setDiscordServerSettings({ tab: selectedDiscordServer })
            }
          />
        ) : (
          <SidebarChromeHeader isElectron={isElectron} />
        )}
        <SidebarContent
          className="min-h-full"
          onPointerEnter={(event) => setSessionListHovered(event.pointerType === "mouse")}
          onPointerLeave={() => setSessionListHovered(false)}
          fixedHeader={
            // Lifted above the stage backdrop, whose fade bleeds below the
            // header and would otherwise paint across the search row's outline.
            <SidebarGroup className="z-[1]">
              <SidebarThreadHeader
                onNewThread={handleNewThreadClick}
                newThreadShortcutLabel={newThreadShortcutLabel}
                searchInputRef={threadSearchInputRef}
                searchLabel={showingTerminalSessions ? "Search terminal sessions" : "Search chats"}
                searchQuery={showingTerminalSessions ? terminalQuery : threadSearchQuery}
                onSearchQueryChange={(value) => {
                  if (showingTerminalSessions) setTerminalQuery(value);
                  else {
                    setThreadSearchQuery(value);
                    setActiveSearchResultIndex(0);
                  }
                }}
                onSearchKeyDown={(event) => {
                  if (!showingTerminalSessions) handleThreadSearchKeyDown(event);
                }}
                isSearching={
                  showingTerminalSessions ? terminalQuery.trim().length > 0 : isShowingThreadResults
                }
                searchResultCount={showingTerminalSessions ? 0 : threadSearchResults.length}
                activeSearchResultIndex={activeSearchResultIndex}
                onClearSearch={
                  showingTerminalSessions ? () => setTerminalQuery("") : clearThreadSearch
                }
              />
              {!showingTerminalSessions || showMachineFilter ? (
                <div
                  role="group"
                  aria-label="Filter chats"
                  // On the chat rows' own inset, like the tabs below. The machine menu
                  // ends the row, so the two filters read as one control.
                  className="@container flex min-w-0 items-center gap-1 pt-1 pb-0.5"
                >
                  {(showingTerminalSessions
                    ? []
                    : ([
                        { id: "all", label: "All", count: null, hint: "All chats" },
                        {
                          id: "unread",
                          label: "Unread",
                          count: quickFilterResult.unreadCount,
                          hint: "Chats with unread replies",
                        },
                        {
                          id: "needs-you",
                          label: "Needs you",
                          count: quickFilterResult.needsYouCount,
                          hint: "Approvals, questions, plans and errors you have not opened yet",
                        },
                      ] as const)
                  ).map((filter) => (
                    <button
                      key={filter.id}
                      type="button"
                      aria-pressed={quickFilter === filter.id}
                      aria-description={filter.hint}
                      onClick={() => {
                        setQuickFilter(filter.id);
                        setActiveSearchResultIndex(0);
                        setSearchVisibleCount(SESSION_LIST_INITIAL_COUNT);
                        threadSearchInputRef.current?.focus();
                      }}
                      className={cn(
                        "inline-flex min-h-6 cursor-pointer items-center gap-1 whitespace-nowrap rounded-md px-2 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none",
                        quickFilter === filter.id
                          ? "bg-sidebar-row-active font-medium text-sidebar-foreground"
                          : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                      )}
                    >
                      {filter.label}
                      {filter.count !== null ? (
                        <span className="text-2xs tabular-nums opacity-70">{filter.count}</span>
                      ) : null}
                    </button>
                  ))}
                  {showMachineFilter ? (
                    <MachineFilterMenu
                      machines={machines.filter((machine) => machineFilterIds.has(machine.id))}
                      selected={selectedMachineId}
                      onSelect={setMachineSelection}
                      className="ml-auto"
                    />
                  ) : null}
                </div>
              ) : null}
              {sidebarLayout === "boxes" || discordMode ? <SidebarBoardLink /> : null}
              <SidebarOverviewLink />
              <SidebarNotesLink />
              <SidebarWorkflowsLink />
              {!discordMode ? (
                <SidebarChatTabs
                  ref={chatTabStripRef}
                  tabs={chatTabViews}
                  selected={selectedChatTab}
                  dropTarget={chatTabDropTarget}
                  renaming={renamingChatTab}
                  onSelect={setChatTabSelection}
                  onContextMenu={(tab, position) => void handleChatTabContextMenu(tab, position)}
                  onRename={renameChatTab}
                  onRenameEnd={() => setRenamingChatTab(null)}
                />
              ) : null}
            </SidebarGroup>
          }
        >
          <SidebarGroup className="flex-1" role="presentation">
            {showingTerminalSessions ? (
              <TerminalSessionList
                key={terminalEnvironmentId}
                environmentId={terminalEnvironmentId}
                label={terminalMachine?.label ?? "Machine"}
                query={terminalQuery}
                connected={terminalMachine?.connected ?? false}
                connecting={terminalMachine?.connecting ?? false}
                configLoaded={terminalConfig !== undefined}
                claudeRemoteControl={terminalConfig?.environment.capabilities.claudeRemoteControl}
                starting={primaryPending}
              />
            ) : isShowingThreadResults ? (
              threadSearchResults.length > 0 ? (
                <TooltipProvider
                  key="sidebar-thread-search-tooltips"
                  delay={700}
                  closeDelay={0}
                  timeout={0}
                >
                  <ul
                    id="sidebar-thread-search-results"
                    role="listbox"
                    aria-label={quickFilter === "all" ? "Chat search results" : "Filtered chats"}
                    className="flex flex-col gap-px"
                  >
                    {visibleThreadSearchResults.map((thread, index) => {
                      if (!("id" in thread))
                        return (
                          <li key={threadSearchMatchKey(thread)}>
                            <button
                              type="button"
                              role="option"
                              id={`sidebar-thread-search-result-${index}`}
                              aria-selected={activeSearchResultIndex === index}
                              aria-posinset={index + 1}
                              aria-setsize={threadSearchResults.length}
                              className={cn(
                                "flex w-full flex-col gap-1 rounded-md px-2.5 py-2 text-left text-sm hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                                activeSearchResultIndex === index && "bg-sidebar-row-hover",
                              )}
                              onFocus={() => setActiveSearchResultIndex(index)}
                              onMouseEnter={() => setActiveSearchResultIndex(index)}
                              onKeyDown={handleThreadSearchKeyDown}
                              onClick={() => selectThreadSearchResult(thread)}
                            >
                              <span>
                                {privateLabel(
                                  "Chat",
                                  thread.threadId,
                                  thread.title || "Untitled chat",
                                )}
                                {thread.archived ? " · Archived" : ""}
                              </span>
                              {!privacy && (
                                <ThreadSearchMatchExcerpt
                                  match={{ ...thread, query: threadSearch.query }}
                                />
                              )}
                            </button>
                          </li>
                        );
                      const threadKey = scopedThreadKey(
                        scopeThreadRef(thread.environmentId, thread.id),
                      );
                      return (
                        <SidebarSearchResultRow
                          prefetch={prefetch}
                          threadPrefetch={threadPrefetch}
                          isSettled={settledThreadKeys.has(threadKey)}
                          key={threadKey}
                          thread={thread}
                          project={
                            projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null
                          }
                          projectDisplayName={
                            projectDisplayNameByKey.get(
                              `${thread.environmentId}:${thread.projectId}`,
                            ) ?? null
                          }
                          environmentLabel={environmentLabelById.get(thread.environmentId) ?? null}
                          environmentMachine={
                            environmentMachineById.get(thread.environmentId) ?? "server"
                          }
                          providerEntryByInstanceId={
                            providerEntriesByEnvironment.get(thread.environmentId) ??
                            EMPTY_PROVIDER_ENTRIES
                          }
                          isHighlighted={activeSearchResultIndex === index}
                          isRouteActive={routeThreadKey === threadKey}
                          resultId={`sidebar-thread-search-result-${index}`}
                          resultIndex={index}
                          resultCount={threadSearchResults.length}
                          searchMatch={
                            threadSearchMatchByKey.get(
                              threadSearchMatchKey({
                                environmentId: thread.environmentId,
                                threadId: thread.id,
                              }),
                            ) ?? null
                          }
                          searchQuery={threadSearchQuery}
                          onHighlight={() => setActiveSearchResultIndex(index)}
                          onSelect={() => selectThreadSearchResult(thread)}
                          onFileDropThreads={handleThreadFileDrop}
                        />
                      );
                    })}
                  </ul>
                  {visibleThreadSearchResults.length < threadSearchResults.length ? (
                    <button
                      type="button"
                      aria-controls="sidebar-thread-search-results"
                      onClick={() =>
                        setSearchVisibleCount((count) => count + SESSION_LIST_PAGE_COUNT)
                      }
                      className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <PlusIcon aria-hidden className="size-4 shrink-0" />
                      Show{" "}
                      {Math.min(
                        threadSearchResults.length - visibleThreadSearchResults.length,
                        SESSION_LIST_PAGE_COUNT,
                      )}{" "}
                      more
                    </button>
                  ) : null}
                </TooltipProvider>
              ) : (
                <p
                  role="status"
                  className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
                >
                  {threadSearch.isPending
                    ? "Searching chat messages…"
                    : threadSearch.failed
                      ? "Couldn't search thread messages"
                      : quickFilter === "unread" && !isSearchingThreads
                        ? "You're all caught up"
                        : quickFilter === "needs-you" && !isSearchingThreads
                          ? "No chats need you right now"
                          : "No chats found"}
                </p>
              )
            ) : null}
            {!showingTerminalSessions && !isShowingThreadResults ? (
              <TooltipProvider
                key="sidebar-thread-tooltips"
                // Chat cards open only on a row the pointer rests on, not on every row it
                // passes on the way to a click, and one card never hands off to the next.
                delay={700}
                closeDelay={0}
                timeout={0}
              >
                <DndContext
                  sensors={dndSensors}
                  autoScroll={!isContextDrag}
                  collisionDetection={dndCollisionDetection}
                  modifiers={[
                    restrictToVerticalAxis,
                    restrictBelowPins,
                    restrictToFirstScrollableAncestor,
                  ]}
                  onDragStart={handleThreadDragStart}
                  onDragOver={handleThreadDragOver}
                  onDragEnd={handleThreadDragEnd}
                >
                  <SidebarDragLifecycle onUnmount={cancelThreadDrag} />
                  <SortableContext items={sortableIds} strategy={sidebarSortingStrategy}>
                    <ul
                      ref={attachListMotionRef}
                      // VoiceOver treats an exposed list as an interaction boundary,
                      // which hides its rows from ordinary linear navigation. A
                      // presentational list also makes its implicit listitems
                      // presentational while preserving every descendant control.
                      role="presentation"
                      className={cn(
                        !discordMode && sessionBoxes !== null
                          ? "relative grid grid-cols-[repeat(auto-fill,minmax(76px,1fr))] content-start gap-1.5"
                          : "relative flex flex-col gap-px",
                        sidebarListItems.length > 0 && "flex-1",
                        // An action sweep owns the pointer: rows it passes over
                        // neither show hover actions nor open tooltips, even
                        // controls that opt back in, like the Woke pill.
                        actionSweep !== null && "**:pointer-events-none",
                      )}
                    >
                      {(() => {
                        const renderThreadRowInner = (
                          thread: EnvironmentThreadShell,
                          section: SidebarSection,
                          sortable?: SortableThreadRowBag,
                          box?: SessionBoxPresentation,
                        ) => {
                          const threadKey = scopedThreadKey(
                            scopeThreadRef(thread.environmentId, thread.id),
                          );
                          // Settled and snoozed are the ONLY things that collapse a
                          // row: every other thread is a full card. Density comes
                          // from users (or the auto rules) actually parking work,
                          // not from the sidebar second-guessing what still matters.
                          // Working rows stay cards so their live status shows.
                          const isCard =
                            section === "active" || section === "pinned" || section === "working";
                          const rowVariant = discordMode
                            ? "discord"
                            : box
                              ? "box"
                              : isCard
                                ? "card"
                                : "slim";
                          const workFacts =
                            section === "pinned" || section === "active"
                              ? longRunningFactsForShell({
                                  hasPendingApprovals: thread.hasPendingApprovals,
                                  hasPendingUserInput: thread.hasPendingUserInput,
                                  pendingSubagentRequest: thread.pendingSubagentRequest ?? null,
                                  runtimeStatus: thread.runtime?.status ?? null,
                                  workingStartedAt: resolveWorkingStartedAt(thread),
                                  pendingBackgroundTasks: thread.pendingBackgroundTasks,
                                  longRunningWork: thread.longRunningWork,
                                  nextScheduledRunAt: thread.nextScheduledRunAt,
                                  nowMs: Date.parse(`${nowMinute}:00.000Z`),
                                })
                              : null;
                          return (
                            <SidebarThreadRow
                              prefetch={prefetch}
                              threadPrefetch={threadPrefetch}
                              box={box}
                              paint={box ? undefined : boxPresentations.get(threadKey)}
                              // Fade between card and compact rows while the outer
                              // sortable wrapper keeps its identity during a drag.
                              key={`${threadKey}:${rowVariant}`}
                              thread={thread}
                              // Pinned and main-list chats say what they have out
                              // (monitors, subagents, a next run) under their title.
                              waitingStatus={
                                workFacts !== null ? pinnedWaitingLine(workFacts) : null
                              }
                              variant={rowVariant}
                              // Snoozed rows wake, settled rows un-settle, and cards settle.
                              variantAction={
                                section === "snoozed"
                                  ? "unsnooze"
                                  : section === "settled"
                                    ? "unsettle"
                                    : "settle"
                              }
                              settlementSupported={
                                serverConfigs.get(thread.environmentId)?.environment.capabilities
                                  .threadSettlement === true
                              }
                              snoozeSupported={
                                serverConfigs.get(thread.environmentId)?.environment.capabilities
                                  .threadSnooze === true
                              }
                              pinningSupported={
                                serverConfigs.get(thread.environmentId)?.environment.capabilities
                                  .threadPinning === true
                              }
                              isPinned={thread.pinnedAt != null}
                              isPending={pendingActions.has(threadKey)}
                              sortable={sortable}
                              dropVerb={
                                dragState?.activeKey === threadKey
                                  ? resolveSidebarDropVerb(
                                      dragState.activeSection,
                                      dragTargetSection,
                                    )
                                  : null
                              }
                              dragOverPinned={
                                dragState?.activeKey === threadKey && dragTargetSection === "pinned"
                              }
                              sweepAction={
                                actionSweep?.keys.has(threadKey) ? actionSweep.action : null
                              }
                              snoozeWakeLabelText={
                                section === "snoozed" && thread.snoozedUntil != null
                                  ? snoozeWakeLabel(thread.snoozedUntil, {
                                      now: new Date().toISOString(),
                                    })
                                  : null
                              }
                              // All sections: a woken thread can classify straight
                              // into the settled tail (PR merged while snoozed), and
                              // the wake signal must survive the trip. Still-snoozed
                              // rows resolve to null on their own.
                              wokeAt={threadWokeAt(thread, { now: snoozeNow })}
                              isActive={routeThreadKey === threadKey}
                              readOpensPullRequestsInRightPanel={readOpensPullRequestsInRightPanel}
                              jumpLabel={
                                showJumpHints ? (jumpLabelByKey.get(threadKey) ?? null) : null
                              }
                              currentEnvironmentId={primaryEnvironmentId}
                              environmentLabel={
                                environmentLabelById.get(thread.environmentId) ?? null
                              }
                              environmentMachine={
                                environmentMachineById.get(thread.environmentId) ?? "server"
                              }
                              scratchMachineLabel={scratchMachineLabelFor(thread)}
                              project={
                                projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ??
                                null
                              }
                              projectDisplayName={
                                projectDisplayNameByKey.get(
                                  `${thread.environmentId}:${thread.projectId}`,
                                ) ?? null
                              }
                              providerEntryByInstanceId={
                                providerEntriesByEnvironment.get(thread.environmentId) ??
                                EMPTY_PROVIDER_ENTRIES
                              }
                              timestampFormat={timestampFormat}
                              onThreadClick={handleThreadClick}
                              onThreadActivate={navigateToThread}
                              onStartRename={startThreadRename}
                              onRenameTitleChange={setRenamingTitle}
                              onCommitRename={commitThreadRename}
                              onCancelRename={cancelThreadRename}
                              isRenaming={renamingThreadKey === threadKey}
                              renamingTitle={renamingThreadKey === threadKey ? renamingTitle : ""}
                              onContextMenu={handleThreadContextMenu}
                              onSettle={attemptSettle}
                              onActionSweepStart={startActionSweep}
                              onUnsettle={attemptUnsettle}
                              onSnooze={attemptSnooze}
                              onUnsnooze={attemptUnsnooze}
                              onUnpin={attemptUnpin}
                              onAcknowledgeWoke={acknowledgeWoke}
                              onFileDropThreads={handleThreadFileDrop}
                              changeRequestSnapshot={
                                changeRequestSnapshotByKey.get(threadKey) ?? null
                              }
                              onChangeRequestSnapshot={setThreadChangeRequestSnapshot}
                            />
                          );
                        };
                        const renderThreadRow = (
                          thread: EnvironmentThreadShell,
                          section: SidebarSection,
                        ) => {
                          const threadKey = scopedThreadKey(
                            scopeThreadRef(thread.environmentId, thread.id),
                          );
                          return (
                            <SortableThreadRow
                              key={threadKey}
                              id={threadKey}
                              contextDrag={isContextDrag}
                              environmentId={thread.environmentId}
                              disabled={
                                renamingThreadKey === threadKey ||
                                section === "working" ||
                                !draggableThreadKeys.has(threadKey) ||
                                optimisticDrop !== null ||
                                pendingActions.size > 0
                              }
                            >
                              {(bag) => renderThreadRowInner(thread, section, bag)}
                            </SortableThreadRow>
                          );
                        };
                        if (discordMode) {
                          const items: ReactNode[] = [
                            <SidebarDraftBlock
                              key="draft-sessions"
                              projectByKey={projectByKey}
                              projectDisplayNameByKey={projectDisplayNameByKey}
                              routeDraftId={routeDraftIdForRows}
                              onNavigateToDraft={navigateToDraft}
                              onDraftContextMenu={handleDraftContextMenu}
                            />,
                          ];
                          for (const [category, entries] of discordGroups) {
                            const collapseKey = `${selectedChatTab}:${category}`;
                            const collapsed = collapsedDiscordCategories.includes(collapseKey);
                            items.push(
                              <li key={`dc-${category}`} className="dc-category">
                                <button
                                  type="button"
                                  aria-expanded={!collapsed}
                                  onClick={() =>
                                    setCollapsedDiscordCategories((categories) =>
                                      collapsed
                                        ? categories.filter((entry) => entry !== collapseKey)
                                        : [...categories, collapseKey],
                                    )
                                  }
                                >
                                  <ChevronRightIcon size={12} data-expanded={!collapsed} />
                                  <span>
                                    {machines.find((machine) => machine.id === category)?.label ??
                                      "Machine"}
                                  </span>
                                  <small>{entries.length}</small>
                                </button>
                                <button
                                  type="button"
                                  aria-label={`New chat in ${machines.find((machine) => machine.id === category)?.label ?? "machine"}`}
                                  onClick={() => {
                                    const environmentId = scratchEnvironmentId(
                                      EnvironmentId.make(category),
                                    );
                                    if (environmentId !== null)
                                      void startScratchThread(environmentId);
                                    else openCommandPalette({ open: "new-thread-in" });
                                  }}
                                >
                                  <PlusIcon size={15} />
                                </button>
                              </li>,
                            );
                            if (collapsed) continue;
                            for (const thread of entries)
                              items.push(
                                renderThreadRow(
                                  thread,
                                  discordSections.get(
                                    scopedThreadKey(
                                      scopeThreadRef(thread.environmentId, thread.id),
                                    ),
                                  ) ?? "active",
                                ),
                              );
                          }
                          if (settledThreads.length > settledVisibleCount)
                            items.push(
                              <li key="dc-more-settled" className="dc-more">
                                <button type="button" onClick={showMoreSettled}>
                                  Show more settled chats
                                </button>
                              </li>,
                            );
                          if (hiddenSessionCount > 0)
                            items.push(
                              <li key="dc-more" className="dc-more">
                                <button type="button" onClick={showMoreSessions}>
                                  Show {Math.min(hiddenSessionCount, SESSION_LIST_PAGE_COUNT)} more
                                  chats
                                </button>
                              </li>,
                            );
                          return items;
                        }
                        if (sessionBoxes !== null) {
                          const boxItems: ReactNode[] = [
                            <li key="draft-sessions" className="col-span-full list-none">
                              <ul className="flex flex-col gap-px">
                                <SidebarDraftBlock
                                  projectByKey={projectByKey}
                                  projectDisplayNameByKey={projectDisplayNameByKey}
                                  routeDraftId={routeDraftIdForRows}
                                  onNavigateToDraft={navigateToDraft}
                                  onDraftContextMenu={handleDraftContextMenu}
                                />
                              </ul>
                            </li>,
                          ];
                          const boxFor = (
                            thread: EnvironmentThreadShell,
                            section: SidebarSection,
                          ) =>
                            renderThreadRowInner(
                              thread,
                              section,
                              undefined,
                              sessionBoxes.byKey.get(
                                scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
                              ),
                            );
                          const heading = (key: string, label: string) => (
                            <li
                              key={key}
                              className="col-span-full list-none px-1 pt-2 text-3xs font-semibold tracking-wide text-sidebar-muted-foreground uppercase first:pt-0"
                            >
                              {label}
                            </li>
                          );
                          if (pinnedThreads.length > 0) {
                            boxItems.push(heading("box-pinned", "Pinned"));
                            for (const thread of pinnedThreads)
                              boxItems.push(boxFor(thread, "pinned"));
                          }
                          const groupLabels = {
                            needsYou: "Needs you",
                            working: "Working",
                            recent: "Recent",
                          } as const;
                          for (const group of ["needsYou", "working", "recent"] as const) {
                            const entries = sessionBoxes.groups[group];
                            if (entries.length === 0) continue;
                            boxItems.push(heading(`box-${group}`, groupLabels[group]));
                            for (const entry of entries) {
                              boxItems.push(
                                boxFor(entry.thread, group === "working" ? "working" : "active"),
                              );
                            }
                          }
                          if (hiddenSessionCount > 0) {
                            boxItems.push(
                              <li key="show-more-sessions" className="col-span-full list-none">
                                <button
                                  type="button"
                                  onClick={showMoreSessions}
                                  className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                                >
                                  <PlusIcon aria-hidden className="size-4 shrink-0" />
                                  Show {Math.min(hiddenSessionCount, SESSION_LIST_PAGE_COUNT)} more
                                </button>
                              </li>,
                            );
                          }
                          const shelf = (
                            key: string,
                            label: string,
                            toggle: { expanded: boolean; onToggle: () => void },
                          ) => (
                            <li key={key} className="col-span-full mt-1 list-none">
                              <CollapsibleSectionHeader
                                onClick={toggle.onToggle}
                                expanded={toggle.expanded}
                                tone="muted"
                              >
                                {label}
                              </CollapsibleSectionHeader>
                            </li>
                          );
                          if (snoozedThreads.length > 0) {
                            boxItems.push(
                              shelf(
                                "box-snoozed",
                                snoozedShelfExpanded
                                  ? "Snoozed"
                                  : `Snoozed (${snoozedThreads.length})`,
                                { expanded: snoozedShelfExpanded, onToggle: toggleSnoozedShelf },
                              ),
                            );
                            for (const thread of visibleSnoozedThreads)
                              boxItems.push(boxFor(thread, "snoozed"));
                          }
                          if (settledThreads.length > 0) {
                            boxItems.push(
                              shelf(
                                "box-settled",
                                settledShelfExpanded
                                  ? "Settled"
                                  : `Settled (${settledThreads.length})`,
                                { expanded: settledShelfExpanded, onToggle: toggleSettledShelf },
                              ),
                            );
                            for (const thread of renderedSettledThreads)
                              boxItems.push(boxFor(thread, "settled"));
                          }
                          return boxItems;
                        }
                        const from = isContextDrag ? null : (dragState?.activeSection ?? null);
                        const items: ReactNode[] = [
                          <SidebarDraftBlock
                            key="draft-sessions"
                            projectByKey={projectByKey}
                            projectDisplayNameByKey={projectDisplayNameByKey}
                            routeDraftId={routeDraftIdForRows}
                            onNavigateToDraft={navigateToDraft}
                            onDraftContextMenu={handleDraftContextMenu}
                          />,
                        ];
                        const lastActiveThread = visibleActiveThreads.at(-1);
                        const showMoreAfterKey =
                          hiddenSessionCount > 0 && lastActiveThread !== undefined
                            ? scopedThreadKey(
                                scopeThreadRef(lastActiveThread.environmentId, lastActiveThread.id),
                              )
                            : null;
                        for (const item of sidebarListItems) {
                          if (item.kind === "thread") {
                            items.push(renderThreadRow(threadByKey.get(item.key)!, item.section));
                            if (item.key === showMoreAfterKey) {
                              items.push(
                                <li key="show-more-sessions" className="list-none">
                                  <button
                                    type="button"
                                    onClick={showMoreSessions}
                                    className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                                  >
                                    <PlusIcon aria-hidden className="size-4 shrink-0" />
                                    Show {Math.min(
                                      hiddenSessionCount,
                                      SESSION_LIST_PAGE_COUNT,
                                    )}{" "}
                                    more
                                  </button>
                                </li>,
                              );
                            }
                            continue;
                          }
                          switch (item.marker) {
                            case "pinned-header":
                              items.push(
                                <SidebarDragBoundary
                                  key="pinned-header"
                                  marker="pinned-header"
                                  label="Pinned"
                                  visible={from !== null}
                                  isDropTarget={dragTargetSection === "pinned"}
                                />,
                              );
                              break;
                            case "pinned-divider":
                              items.push(
                                <SidebarDragBoundary
                                  key="pinned-divider"
                                  marker="pinned-divider"
                                  label="Active"
                                  visible={from !== null}
                                  isDropTarget={dragTargetSection === "active"}
                                />,
                              );
                              break;
                            case "active-placeholder":
                              items.push(
                                <SidebarSectionPlaceholder
                                  key="active-placeholder"
                                  marker="active-placeholder"
                                  label="Active"
                                  showHint={
                                    from !== null &&
                                    (activeThreads.length === 0 ||
                                      (from === "active" &&
                                        activeThreads.length === 1 &&
                                        dragTargetSection !== null &&
                                        dragTargetSection !== "active"))
                                  }
                                  isDropTarget={dragTargetSection === "active"}
                                />,
                              );
                              break;
                            case "working-header":
                              items.push(
                                <SidebarSectionHeader
                                  key="working-shelf-header"
                                  marker="working-header"
                                  className="mt-auto"
                                  label="Working"
                                  count={workingThreads.length}
                                  toggle={{
                                    expanded: workingShelfExpanded,
                                    onToggle: toggleWorkingShelf,
                                  }}
                                />,
                              );
                              break;
                            case "snoozed-header":
                              items.push(
                                <SidebarSectionHeader
                                  key="snoozed-shelf-header"
                                  marker="snoozed-header"
                                  className={cn(workingThreads.length === 0 && "mt-auto")}
                                  label="Snoozed"
                                  count={snoozedThreads.length}
                                  toggle={{
                                    expanded: snoozedShelfExpanded,
                                    onToggle: toggleSnoozedShelf,
                                  }}
                                />,
                              );
                              break;
                            case "settled-header":
                              items.push(
                                <SidebarSectionHeader
                                  key="settled-shelf-header"
                                  marker="settled-header"
                                  className={cn(
                                    workingThreads.length + snoozedThreads.length === 0 &&
                                      "mt-auto",
                                  )}
                                  label="Settled"
                                  count={settledThreads.length}
                                  dragging={from !== null}
                                  isDropTarget={dragTargetSection === "settled"}
                                  toggle={{
                                    expanded: settledShelfExpanded,
                                    onToggle: toggleSettledShelf,
                                  }}
                                />,
                              );
                              break;
                            case "settled-placeholder":
                              items.push(
                                <SidebarSectionPlaceholder
                                  key="settled-placeholder"
                                  marker="settled-placeholder"
                                  label="Settled"
                                  showHint={
                                    from !== null &&
                                    (renderedSettledThreads.length === 0 ||
                                      (from === "settled" &&
                                        renderedSettledThreads.length === 1 &&
                                        dragTargetSection !== null &&
                                        dragTargetSection !== "settled"))
                                  }
                                  isDropTarget={dragTargetSection === "settled"}
                                />,
                              );
                              break;
                          }
                        }
                        return items;
                      })()}
                      {settledShelfExpanded && hiddenSettledCount > 0 ? (
                        <li className="list-none">
                          <button
                            type="button"
                            onClick={showMoreSettled}
                            className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                          >
                            <PlusIcon aria-hidden className="size-4 shrink-0" />
                            Show {Math.min(hiddenSettledCount, SETTLED_TAIL_PAGE_COUNT)} more
                          </button>
                        </li>
                      ) : null}
                    </ul>
                  </SortableContext>
                </DndContext>
              </TooltipProvider>
            ) : null}
            {!showingTerminalSessions &&
            !isShowingThreadResults &&
            shellsBootstrapped &&
            visibleDraftSessionCount === 0 &&
            pinnedThreads.length +
              activeThreads.length +
              workingThreads.length +
              snoozedThreads.length +
              settledThreads.length ===
              0 ? (
              <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                No chats yet
              </div>
            ) : null}
          </SidebarGroup>
        </SidebarContent>
        <SidebarChromeFooter />
        {discordMode ? <DiscordUserPanel machine={selectedMachine} /> : null}
      </div>
    </div>
  );
});
