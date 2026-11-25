import { usePrivacyLabel, usePrivacyMode } from "../../state/use-privacy-mode";
import { threadHasUnreadOutput } from "../discord/homeMachineModel";
import { useUiMode } from "../discord/useUiMode";
import * as DiscordHaptics from "expo-haptics";
import { threadRowInstanceId, type ThreadRowProviderInstance } from "./thread-provider-instance";
import {
  THREAD_LIST_V2_MONO_FONT as MONO_FONT,
  THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME,
  THREAD_LIST_V2_ROW_DIVIDERS,
  selectedThreadRowColors,
  getThreadListV2NewBranchMenuTitle,
  getThreadListV2RowAppearance,
} from "./thread-list-v2-row-appearance";
import { RowPressable } from "../../components/RowPressable";
import { CustomSnoozeSheet } from "./CustomSnoozeSheet";
import { appAtomRegistry } from "../../state/atom-registry";
import { preloadPhoneThread } from "../../state/threads";
import { threadArrangementOpenAtom } from "../../state/thread-order";
import type { ThreadMoveDestination } from "./threadOrder";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { canSnooze, resolveSnoozePresets } from "@t3tools/client-runtime/state/thread-settled";
import { threadRowPreview } from "@t3tools/client-runtime/state/thread-row-preview";
import type { MenuAction } from "@react-native-menu/menu";
import { memo, useCallback, useEffect, useMemo, useState, type ComponentProps } from "react";
import { Alert, Pressable, useWindowDimensions, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import type { ThreadListProvider } from "../../state/thread-list-environments";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { ProviderInstanceIcon } from "../../components/ProviderIcon";
import { providerInstanceNameLabel } from "../../lib/providerInstanceName";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useEnvironmentScope } from "../../state/session";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { useThreadPr } from "../../state/use-thread-pr";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";
import { useSwipeRowDormant } from "../home/swipe-row-activation";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { buildThreadTitleRegenerationMenuItems } from "./thread-title-regeneration-menu";
import { useChatTabRowMenu } from "../chatTabs/ChatTabs";
import {
  presentSessionBoxCached,
  sessionBoxConnectionPresentation,
} from "@t3tools/client-runtime/state/session-boxes";
import type { SessionBoxIconId } from "@t3tools/shared/sessionBoxes";
import { SessionBoxPainting } from "../sessionBoxes/SessionBoxTile";

/** The chat's painting at the start of a list row: big enough to read, unlike in the boxes. */
const ROW_PAINTING_SIZE = 36;
import {
  resolveThreadListV2SnoozeGateExpiryMs,
  resolveThreadListV2SnoozeMenuSelection,
  threadHasUnseenCompletion,
  resolveThreadListV2Status,
  resolveThreadListV2DisplayStatus,
  resolveThreadListV2SwipeActions,
  threadListV2SwipeResetKey,
  type ThreadListV2Status,
} from "./threadListV2";
import { WorkingStatusIndicator } from "./WorkingStatusIndicator";
import { useVisibleSecondClock } from "./use-visible-second-clock";
import {
  resolveThreadLastActivityAt,
  resolveThreadWorkingStartedAt,
} from "@t3tools/client-runtime/state/models";
import { longRunningStatusForShell, quietTurnLabel } from "@t3tools/shared/chatControls";

import { QueuedMessageIcon } from "./queued-message-icon";
import { ThreadSearchMatchExcerpt } from "./thread-search-match";
import { threadReadMenuAction, useThreadReadAction } from "./threadReadActions";
import {
  threadRowAccessibilityActions,
  threadRowAccessibilityLabel,
} from "./threadRowAccessibility";

/**
 * Only working rows tick, and only while the list can be seen. A turn that has shown nothing
 * for a long while reads "Quiet 22m" in grey with a still mark: possibly stuck, possibly a slow
 * silent step, so the label says only what is known (the Mac sidebar does the same).
 */
function WorkingThreadRowStatus(props: {
  readonly startedAt: string | null;
  readonly lastActivityAt: string | null;
  readonly active: boolean;
  readonly selected: boolean;
}) {
  const nowMs = useVisibleSecondClock(props.active);
  const quietLabel = quietTurnLabel(
    props.lastActivityAt === null ? null : Date.parse(props.lastActivityAt),
    nowMs,
  );
  const quiet = quietLabel !== null;
  return (
    <View className="flex-row items-center gap-1">
      <WorkingStatusIndicator
        active={props.active && !quiet}
        tintColorClassName={
          props.selected
            ? selectedThreadRowColors.iconTintClassName
            : quiet
              ? "accent-foreground-muted"
              : "accent-primary"
        }
      />
      <Text
        className={cn(
          "text-xs tabular-nums",
          props.selected
            ? selectedThreadRowColors.foregroundClassName
            : quiet
              ? "text-foreground-muted"
              : "text-primary",
        )}
        numberOfLines={1}
      >
        {quietLabel ??
          longRunningStatusForShell({
            runtimeStatus: "running",
            workingStartedAt: props.startedAt,
            nowMs,
          })}
      </Text>
    </View>
  );
}

/**
 * Thread List v2 renders one flat native list of equal-weight rows with
 * native swipe and long-press actions. State reads through colored status
 * labels and an unread dot rather than card fills or dimming.
 */

// Status hues follow the system-wide convention set by sidebar v1 and the
// Live Activity/widgets (amber approval, indigo input, sky working) so a
// thread reads the same color everywhere it surfaces.
// Icons match the web sidebar's status glyphs.
interface StatusLabel {
  readonly label: string;
  readonly icon: AppSymbolName;
  readonly className: string;
  readonly iconTintClassName: string;
}
const STATUS_LABEL_BY_STATUS: Partial<
  Record<ThreadListV2Status | "connecting" | "reconnecting" | "offline", StatusLabel>
> = {
  connecting: {
    label: "Connecting",
    icon: "circle.dashed",
    className: "text-foreground-muted",
    iconTintClassName: "accent-foreground-muted",
  },
  reconnecting: {
    label: "Reconnecting",
    icon: "circle.dashed",
    className: "text-foreground-muted",
    iconTintClassName: "accent-foreground-muted",
  },
  offline: {
    label: "Offline",
    icon: "circle.dashed",
    className: "text-foreground-muted",
    iconTintClassName: "accent-foreground-muted",
  },
  approval: {
    label: "Approval",
    icon: "exclamationmark.shield",
    className: "text-warning-foreground",
    iconTintClassName: "accent-warning-foreground",
  },
  input: {
    label: "Input",
    icon: "questionmark.bubble",
    className: "text-adaptive-indigo-600-300",
    iconTintClassName: "accent-adaptive-indigo-600-300",
  },
  working: {
    label: "Working",
    icon: "circle.dashed",
    className: "text-adaptive-sky-600-400",
    iconTintClassName: "accent-adaptive-sky-600-400",
  },
  waiting: {
    label: "Waiting",
    icon: "circle.dashed.inset.filled",
    className: "text-foreground-muted",
    iconTintClassName: "accent-foreground-muted",
  },
  failed: {
    label: "Failed",
    icon: "exclamationmark.circle",
    className: "text-danger-foreground",
    iconTintClassName: "accent-danger-foreground",
  },
  limited: {
    label: "Limited",
    icon: "exclamationmark.circle",
    className: "text-warning-foreground",
    iconTintClassName: "accent-warning-foreground",
  },
};

// Settlement keeps history reachable; Archive remains a separate action.
const ARCHIVE_MENU_ACTION: MenuAction = { id: "archive", title: "Archive", image: "archivebox" };
const DELETE_MENU_ACTION: MenuAction = {
  id: "delete",
  title: "Delete",
  image: "trash",
  attributes: { destructive: true },
};
const WAKE_MENU_ACTION: MenuAction = { id: "unsnooze", title: "Wake chat", image: "clock" };

/** Rounded-row radius shared with the v1 sidebar rows. */
const SIDEBAR_V2_ROW_RADIUS = 12;

/** Shared disclosure for snoozed and settled history. */
export const ThreadListV2SnoozedShelfHeader = memo(function ThreadListV2SnoozedShelfHeader(props: {
  readonly count: number;
  readonly label?: "Snoozed" | "Settled";
  readonly disabled?: boolean;
  readonly expanded: boolean;
  /** The search forced the rows open: render a plain section label with no
      toggle, so a tap cannot flip the saved preference without any visible
      effect. */
  readonly searchExpanded?: boolean;
  readonly onToggle: () => void;
  readonly pane?: "screen" | "sidebar";
}) {
  const sidebarPane = props.pane === "sidebar";
  const label = props.label ?? "Snoozed";
  const searchExpanded = props.searchExpanded === true;
  return (
    <Pressable
      accessibilityHint={
        searchExpanded
          ? undefined
          : `${props.expanded ? "Collapses" : "Expands"} the ${label.toLowerCase()} chats.`
      }
      accessibilityLabel={`${props.count} ${label.toLowerCase()} ${props.count === 1 ? "chat" : "chats"}`}
      accessibilityRole={searchExpanded ? "header" : "button"}
      accessibilityState={
        searchExpanded ? undefined : { disabled: props.disabled, expanded: props.expanded }
      }
      // Padding rather than margin, and a 44pt floor: the label is the only
      // way to open settled history, so the whole band must take the tap.
      className={cn(
        "min-h-[44px] flex-row items-center gap-2.5 pt-4 pb-1.5",
        sidebarPane ? "px-3" : "px-5",
      )}
      disabled={props.disabled || searchExpanded}
      onPress={props.onToggle}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <Text
        className={cn(
          "text-xs font-t3-medium",
          sidebarPane ? "text-drawer-foreground-muted" : "text-foreground-secondary",
        )}
      >
        {label === "Snoozed"
          ? props.expanded
            ? label
            : `${label} (${props.count})`
          : `${label} · ${props.count}`}
      </Text>
      <View className="h-px flex-1 bg-primary/20" />
      {searchExpanded ? null : (
        <SymbolView
          name="chevron.down"
          size={10}
          tintColorClassName={sidebarPane ? "accent-drawer-foreground-muted" : "accent-icon-muted"}
          type="monochrome"
          style={{ transform: [{ rotate: props.expanded ? "180deg" : "0deg" }] }}
        />
      )}
    </Pressable>
  );
});

/** Small accent dot beside the time on rows with a completion the user has
    not opened yet. */
function UnreadDot() {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="size-2 rounded-full bg-primary"
    />
  );
}

const PENDING_TASK_MENU_ACTIONS: MenuAction[] = [
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

const DRAFT_TASK_MENU_ACTIONS: MenuAction[] = [
  { id: "delete", title: "Discard", image: "trash", attributes: { destructive: true } },
];

/**
 * Unsent work, in the same idiom as a thread row: it is work the user wrote,
 * so it reads like the thread it will become. The status slot says what
 * happens next: "Sends on reconnect" stays uncolored because nothing is asked
 * of the user; "Draft" takes the amber the web sidebar uses for drafts,
 * because this one waits on the user.
 */
export const ThreadListV2PendingRow = memo(function ThreadListV2PendingRow(props: {
  readonly pendingTask: PendingNewTask;
  readonly pane?: "screen" | "sidebar";
  /** Keeps row hairlines inside a section; section headers draw their own rule. */
  readonly showTrailingDivider?: boolean;
  readonly onSelectPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onDeletePendingTask: (pendingTask: PendingNewTask) => void;
}) {
  const { pendingTask, onSelectPendingTask, onDeletePendingTask } = props;
  const sidebarPane = props.pane === "sidebar";
  const isDraft = pendingTask.kind === "draft";

  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "delete") onDeletePendingTask(pendingTask);
    },
    [onDeletePendingTask, pendingTask],
  );

  const rowContent = (
    <View className="flex-row items-start gap-2">
      {/* One line, unlike the two a thread row allows: a queued title is
          derived from the whole prompt rather than written as a title, so the
          second line is usually a stray word or emoji rather than meaning. */}
      <Text
        className={cn(
          "min-w-0 flex-1 text-base font-t3-medium text-foreground",
          sidebarPane && "text-drawer-foreground",
        )}
        numberOfLines={1}
      >
        {pendingTask.title}
      </Text>
      <View className="flex-row items-center gap-1 pt-[3px]">
        {isDraft ? (
          <>
            <SymbolView
              name="square.and.pencil"
              size={10}
              tintColorClassName="accent-adaptive-amber-700-300"
              type="monochrome"
            />
            <Text className="text-xs text-adaptive-amber-700-300">Draft</Text>
          </>
        ) : (
          <Text
            className={cn(
              "text-xs text-foreground-tertiary",
              sidebarPane && "text-drawer-foreground-muted",
            )}
          >
            Sends on reconnect
          </Text>
        )}
      </View>
    </View>
  );

  return (
    <ControlPillMenu
      actions={isDraft ? DRAFT_TASK_MENU_ACTIONS : PENDING_TASK_MENU_ACTIONS}
      onPressAction={handleMenuAction}
      shouldOpenOnLongPress
    >
      <RowPressable
        accessibilityHint={
          isDraft
            ? "Opens the draft"
            : "Sends when the environment reconnects. Opens it for editing"
        }
        accessibilityLabel={pendingTask.title}
        accessibilityRole="button"
        key={pendingTask.key}
        className={sidebarPane ? "bg-drawer" : "bg-screen"}
        interactionClassName={sidebarPane ? "bg-thread-hover" : "bg-row-hover"}
        onPress={() => onSelectPendingTask(pendingTask)}
        style={
          sidebarPane
            ? {
                borderRadius: SIDEBAR_V2_ROW_RADIUS,
                paddingHorizontal: 12,
                paddingVertical: 10,
              }
            : undefined
        }
      >
        {sidebarPane ? (
          rowContent
        ) : (
          <View>
            <View className="px-5 py-2.5">{rowContent}</View>
            {props.showTrailingDivider !== false ? (
              <View className="ml-5 h-px bg-border-subtle" />
            ) : null}
          </View>
        )}
      </RowPressable>
    </ControlPillMenu>
  );
});

export const ThreadListV2Row = memo(function ThreadListV2Row(props: {
  readonly readOnly?: boolean;
  readonly thread: EnvironmentThreadShell;
  /** The row's painting, picked against the other rows; the thread id picks one without it. */
  readonly face?: SessionBoxIconId | undefined;
  /** A message for this thread is waiting in the outbox. */
  readonly hasQueuedMessages?: boolean;
  /** Snoozed-shelf row: shows its wake time and offers Wake. */
  readonly snoozed?: boolean;
  readonly settled?: boolean;
  readonly settlementSupported?: boolean;
  readonly onSettleThread?: (thread: EnvironmentThreadShell) => void;
  readonly onUnsettleThread?: (thread: EnvironmentThreadShell) => void;
  /** Pinned-block row: shows the pin glyph and offers Unpin. */
  readonly pinned?: boolean;
  /** Replaces the trailing time with what the chat is waiting on. */
  readonly longRunningStatus?: string | null;
  /** Preformatted against the parent minute tick so this memoized row's
      countdown keeps moving. */
  readonly snoozeWakeLabelText?: string;
  /** Preformatted against the parent clock (the latest activity the list
      sorts by). Blank while a status label or the wake countdown owns that
      slot. Precomputed per row — not via the list's extraData — so the minute
      tick re-renders only rows whose displayed text moved. */
  readonly timeLabel: string;
  /** Parent minute tick carried on the row's list item, present only when the
      row's menu offers snooze presets, so those menus refresh while mounted
      without invalidating every other row. */
  readonly snoozePresetMinute: string;
  /** Keep the environment's provider array stable across unrelated list updates. */
  readonly providers: ReadonlyArray<ThreadListProvider> | undefined;
  readonly providerInstance: ThreadRowProviderInstance | null;
  /** Hosting surface. "screen" (default) renders the compact Home idiom:
      flat edge-to-edge rows on the screen background with inset hairlines.
      "sidebar" renders the iPad split-view idiom: rounded rows blending
      into the drawer surface, selection filled with the accent color —
      matching the v1 sidebar rows. */
  readonly pane?: "screen" | "sidebar";
  /** Keeps row hairlines inside a section; section headers draw their own rule. */
  readonly showTrailingDivider?: boolean;
  /** Highlights the thread open in the detail pane (iPad split view). The
      compact Home list never sets it — phones navigate away on select. */
  readonly selected?: boolean;
  /** Override for narrow panes (iPad sidebar); defaults to window width. */
  readonly fullSwipeWidth?: number;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onNewThreadOnBranch: (thread: EnvironmentThreadShell) => void;
  readonly onRenameThread: (thread: EnvironmentThreadShell) => void;
  readonly onRegenerateThreadTitle: (thread: EnvironmentThreadShell) => void;
  readonly onSnoozeThread: (thread: EnvironmentThreadShell, snoozedUntil: string) => void;
  readonly onUnsnoozeThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onPinThread: (thread: EnvironmentThreadShell) => void;
  readonly onUnpinThread: (thread: EnvironmentThreadShell) => void;
  /** False on servers that predate thread.snooze/unsnooze. */
  readonly snoozeSupported: boolean;
  /** False on servers that predate thread.pin/unpin. */
  readonly pinningSupported: boolean;
  /** False on servers that predate thread title regeneration. */
  readonly titleRegenerationSupported: boolean;
  /** Server supports reordering this row's pinned block. */
  readonly reorderSupported?: boolean;
  readonly onMoveThread?: (
    thread: EnvironmentThreadShell,
    direction: ThreadMoveDestination,
  ) => void;
  /** Position flags within the pinned block so the menu disables the move
      that would fall off the end of it. */
  readonly canMoveUp?: boolean;
  readonly canMoveDown?: boolean;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  /** List key checked against the Home swipe row activation. */
  readonly activationKey?: string;
  readonly searchMatch?: EnvironmentThreadSearchMatch;
  readonly searchQuery?: string;
  readonly simultaneousSwipeGesture?: ComponentProps<typeof ThreadSwipeable>["simultaneousWith"];
}) {
  const privateLabel = usePrivacyLabel();
  const displayTitle = privateLabel("Chat", props.thread.id, props.thread.title);
  const privacy = usePrivacyMode();
  const [uiMode] = useUiMode();
  const discord = uiMode === "discord";
  const { width: windowWidth } = useWindowDimensions();
  const {
    thread,
    onSelectThread,
    onDeleteThread,
    onRenameThread,
    onRegenerateThreadTitle,
    onNewThreadOnBranch,
    onSnoozeThread,
    onUnsnoozeThread,
    onArchiveThread,
    onPinThread,
    onUnpinThread,
    onMoveThread,
  } = props;
  const snoozedRow = props.snoozed === true;
  const pinnedRow = props.pinned === true;
  const dormant = useSwipeRowDormant(props.activationKey);

  const providerIconUrl = useMemo(
    () =>
      props.providers?.find(
        (candidate) => candidate.instanceId === threadRowInstanceId(props.providers, thread),
      )?.iconUrl,
    [thread, props.providers],
  );

  const providerInstance = props.providerInstance;
  const providerNameLabel = providerInstance
    ? providerInstanceNameLabel({
        provider: providerInstance.driverKind,
        iconUrl: providerIconUrl,
        displayName: providerInstance.displayName,
        showBadge: providerInstance.showBadge,
      })
    : null;
  const pr = useThreadPr(thread);

  const theme = useUniwindTheme();
  const sidebarPane = props.pane === "sidebar";
  const selected = props.selected === true;
  const rowAppearance = getThreadListV2RowAppearance(theme, sidebarPane, selected);

  const connection = useRemoteEnvironmentRuntime(thread.environmentId);
  const status = resolveThreadListV2DisplayStatus(
    resolveThreadListV2Status(thread),
    connection?.connectionState,
    props.longRunningStatus,
  );
  // The unread dot marks a completion the user has not opened yet, sourced
  // from the server-side visited watermark so checking a thread on any device
  // clears it everywhere.
  const isUnread = discord
    ? threadHasUnreadOutput(thread)
    : status === "ready" && threadHasUnseenCompletion(thread);
  // The chat's painting, as in the boxes: its topic face and what it is doing now. Only the
  // pictures are read, so the clock doesn't matter and the cached object is reused.
  const paint = useMemo(
    () =>
      sessionBoxConnectionPresentation(
        presentSessionBoxCached(thread, { now: 0, unseen: isUnread, face: props.face }),
        connection?.connectionState,
      ),
    [thread, isUnread, props.face, connection?.connectionState],
  );
  // The row's second line: what a working agent last said (or the kind of step it is on),
  // else how its latest reply opens. Private mode hides titles, so it hides these words too.
  const replyPreview = thread.source.replyPreview;
  const preview = useMemo(
    () =>
      privacy
        ? null
        : threadRowPreview({
            stepText: paint.activity !== null ? paint.status : null,
            asking: paint.tone === "asking",
            replyPreview,
          }),
    [privacy, paint.activity, paint.status, paint.tone, replyPreview],
  );
  const statusLabel = STATUS_LABEL_BY_STATUS[status];
  const disconnected = status === "connecting" || status === "reconnecting" || status === "offline";
  const needsYou =
    !disconnected &&
    (status === "approval" || status === "input" || props.longRunningStatus === "Needs you");
  const rowStatusText = disconnected
    ? statusLabel?.label
    : needsYou
      ? "Needs you"
      : (props.longRunningStatus ?? statusLabel?.label);
  const snoozeWakeLabelText = snoozedRow ? props.snoozeWakeLabelText : undefined;
  // The timestamp is precomputed on the list item (the same stamp the list
  // sorts by) so a minute tick only re-renders rows that draw it.
  const timeLabel = props.timeLabel;

  const handleDelete = useCallback(() => onDeleteThread(thread), [onDeleteThread, thread]);
  const handleRename = useCallback(() => {
    if (!privacy) onRenameThread(thread);
  }, [privacy, onRenameThread, thread]);
  const canOperateThread = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const changeReadState = useThreadReadAction();
  const lastVisitedAt = thread.lastVisitedAt;
  const readMenuAction = useMemo(
    () => threadReadMenuAction({ lastVisitedAt }, isUnread),
    [isUnread, lastVisitedAt],
  );
  const handleRegenerateTitle = useCallback(
    () => onRegenerateThreadTitle(thread),
    [onRegenerateThreadTitle, thread],
  );
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);
  // A recycled cell reassigns this mounted row to a different thread without
  // remounting it, and the render closure stops running while list equality
  // says the item is unchanged — so any row-local UI state must be dismissed
  // when the identity under it changes. Without this, a custom snooze sheet
  // opened for one thread survives the thread's removal/reorder and its
  // submit snoozes whichever thread the cell was reassigned to. (ThreadSwipeable
  // enforces the same contract on the swipe layer with its resetKey.)
  const rowIdentity = `${thread.environmentId}:${thread.id}`;
  const [boundIdentity, setBoundIdentity] = useState(rowIdentity);
  if (boundIdentity !== rowIdentity) {
    setBoundIdentity(rowIdentity);
    setCustomSnoozeOpen(false);
  }
  const handleSnooze = useCallback(
    (snoozedUntil: string) => onSnoozeThread(thread, snoozedUntil),
    [onSnoozeThread, thread],
  );
  const handleUnsnooze = useCallback(() => onUnsnoozeThread(thread), [onUnsnoozeThread, thread]);
  const handlePin = useCallback(() => onPinThread(thread), [onPinThread, thread]);
  const handleUnpin = useCallback(() => onUnpinThread(thread), [onUnpinThread, thread]);
  const handleMoveUp = useCallback(() => onMoveThread?.(thread, "up"), [onMoveThread, thread]);
  const handleMoveDown = useCallback(() => onMoveThread?.(thread, "down"), [onMoveThread, thread]);
  const handleSettle = useCallback(
    () => props.onSettleThread?.(thread),
    [props.onSettleThread, thread],
  );
  const handleUnsettle = useCallback(
    () => props.onUnsettleThread?.(thread),
    [props.onUnsettleThread, thread],
  );
  const handleArchive = useCallback(() => onArchiveThread(thread), [onArchiveThread, thread]);

  const [snoozeGateTick, bumpSnoozeGateTick] = useState(0);
  const snoozeGateExpiryMs = props.snoozeSupported
    ? resolveThreadListV2SnoozeGateExpiryMs(thread, { now: new Date().toISOString() })
    : null;
  useEffect(() => {
    if (snoozeGateExpiryMs === null) return;
    const delayMs = Math.min(Math.max(0, snoozeGateExpiryMs - Date.now()) + 50, 2_147_483_647);
    const id = setTimeout(() => bumpSnoozeGateTick((tick) => tick + 1), delayMs);
    return () => clearTimeout(id);
  }, [snoozeGateExpiryMs, snoozeGateTick]);
  const swipeActions = resolveThreadListV2SwipeActions({
    settlementSupported: props.settlementSupported,
    settled: props.settled,
    snoozeSupported: props.snoozeSupported,
    snoozable: canSnooze(thread, { now: new Date().toISOString() }),
    snoozed: snoozedRow,
  });
  const snoozePresets = useMemo(
    () => (swipeActions.secondary === "snooze" ? resolveSnoozePresets(new Date()) : ([] as const)),
    [props.snoozePresetMinute, swipeActions.secondary],
  );
  const snoozePresetActions = useMemo<MenuAction[]>(
    () => [
      ...snoozePresets.map((preset) => ({
        id: `snooze:${preset.id}`,
        title: preset.label,
        subtitle: preset.whenLabel,
      })),
      { id: "snooze:custom", title: "Custom…" },
    ],
    [snoozePresets],
  );
  // Only the pinned block keeps a manual arrangement; everything else orders
  // itself by activity.
  const arrangementMenuItems = useMemo<MenuAction[]>(
    () => [
      ...(pinnedRow && props.reorderSupported === true
        ? [
            { id: "arrange", title: "Arrange chats…", image: "line.3.horizontal" },
            {
              id: "move-up",
              title: "Move up",
              image: "arrow.up",
              attributes: { disabled: props.canMoveUp !== true },
            } satisfies MenuAction,
            {
              id: "move-down",
              title: "Move down",
              image: "arrow.down",
              attributes: { disabled: props.canMoveDown !== true },
            } satisfies MenuAction,
          ]
        : []),
      ...(props.pinningSupported
        ? [
            thread.pinnedAt != null
              ? { id: "unpin", title: "Unpin", image: "pin.slash" }
              : { id: "pin", title: "Pin", image: "pin" },
          ]
        : []),
    ],
    [
      pinnedRow,
      props.canMoveDown,
      props.canMoveUp,
      props.reorderSupported,
      props.pinningSupported,
      thread.pinnedAt,
    ],
  );
  const titleMenuItems = useMemo<MenuAction[]>(
    () => [
      { id: "rename", title: "Rename", image: "square.and.pencil" },
      ...buildThreadTitleRegenerationMenuItems({
        supported: props.titleRegenerationSupported,
        isRegenerating: thread.titleRegeneration != null,
      }),
    ],
    [props.titleRegenerationSupported, thread.titleRegeneration],
  );
  const chatTabMenu = useChatTabRowMenu(thread);
  const menuActions = useMemo<MenuAction[]>(
    () => [
      ...(readMenuAction ? [readMenuAction] : []),
      ...(thread.branch
        ? [
            {
              id: "new-thread-on-branch",
              title: getThreadListV2NewBranchMenuTitle(thread.branch),
              image: "square.and.pencil",
            },
          ]
        : []),
      { id: "copy-thread-id", title: "Copy chat ID", image: "doc.on.doc" },
      ...(snoozedRow
        ? [WAKE_MENU_ACTION]
        : [
            ...(props.settlementSupported
              ? [
                  {
                    id: props.settled ? "unsettle" : "settle",
                    title: props.settled ? "Un-settle" : "Settle",
                    image: props.settled ? "arrow.uturn.backward" : "checkmark",
                  },
                ]
              : []),
            ARCHIVE_MENU_ACTION,
            ...(swipeActions.secondary === "snooze"
              ? [
                  {
                    id: "snooze",
                    title: "Snooze",
                    image: "clock",
                    subactions: snoozePresetActions,
                  } satisfies MenuAction,
                ]
              : []),
            ...arrangementMenuItems,
          ]),
      ...(chatTabMenu.action === null ? [] : [chatTabMenu.action]),
      ...titleMenuItems,
      DELETE_MENU_ACTION,
    ],
    [
      readMenuAction,
      chatTabMenu.action,
      arrangementMenuItems,
      props.settlementSupported,
      props.settled,
      snoozePresetActions,
      snoozedRow,
      swipeActions.secondary,
      thread.branch,
      titleMenuItems,
    ],
  );
  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "mark-read" || nativeEvent.event === "mark-unread") {
        void changeReadState(thread, nativeEvent.event);
        return;
      }
      if (chatTabMenu.handle(nativeEvent.event)) return;
      if (nativeEvent.event === "new-thread-on-branch") onNewThreadOnBranch(thread);
      if (nativeEvent.event === "unsnooze") handleUnsnooze();
      if (nativeEvent.event === "pin") handlePin();
      if (nativeEvent.event === "unpin") handleUnpin();
      if (nativeEvent.event === "arrange") appAtomRegistry.set(threadArrangementOpenAtom, true);
      if (nativeEvent.event === "move-up") handleMoveUp();
      if (nativeEvent.event === "move-down") handleMoveDown();
      if (nativeEvent.event === "archive") handleArchive();
      if (nativeEvent.event === "settle") handleSettle();
      if (nativeEvent.event === "unsettle") handleUnsettle();
      if (nativeEvent.event === "rename") handleRename();
      if (nativeEvent.event === "regenerate-title") handleRegenerateTitle();
      if (nativeEvent.event === "copy-thread-id") {
        copyTextWithHaptic(thread.id, { target: "thread-id" });
      }
      if (nativeEvent.event === "delete") handleDelete();
      if (nativeEvent.event === "snooze:custom") {
        setCustomSnoozeOpen(true);
        return;
      }
      const snoozeSelection = resolveThreadListV2SnoozeMenuSelection({
        event: nativeEvent.event,
        displayedPresets: snoozePresets,
        now: new Date(),
      });
      if (snoozeSelection._tag === "selected") {
        handleSnooze(snoozeSelection.preset.snoozedUntil);
      } else if (snoozeSelection._tag === "expired") {
        Alert.alert("Could not snooze chat", "That snooze time has passed. Choose another time.");
      }
    },
    [
      changeReadState,
      chatTabMenu,
      onNewThreadOnBranch,
      thread,
      handleArchive,
      handleSettle,
      handleUnsettle,
      handleDelete,
      handleRegenerateTitle,
      handleRename,
      handleMoveDown,
      handleMoveUp,
      handlePin,
      handleSnooze,
      handleUnpin,
      handleUnsnooze,
      setCustomSnoozeOpen,
      snoozePresets,
    ],
  );
  const primaryAction = useMemo(
    () =>
      swipeActions.primary === "unsnooze"
        ? {
            accessibilityLabel: `Wake ${displayTitle} now`,
            icon: "clock" as const,
            label: "Wake",
            onPress: handleUnsnooze,
          }
        : swipeActions.primary === "settle"
          ? {
              accessibilityLabel: `Settle ${displayTitle}`,
              icon: "checkmark" as const,
              label: "Settle",
              onPress: handleSettle,
            }
          : swipeActions.primary === "unsettle"
            ? {
                accessibilityLabel: `Un-settle ${displayTitle}`,
                icon: "arrow.uturn.backward" as const,
                label: "Un-settle",
                onPress: handleUnsettle,
              }
            : {
                accessibilityLabel: `Archive ${displayTitle}`,
                icon: "archivebox" as const,
                label: "Archive",
                onPress: handleArchive,
              },
    [
      handleArchive,
      handleSettle,
      handleUnsettle,
      handleUnsnooze,
      swipeActions.primary,
      displayTitle,
    ],
  );
  const secondaryAction = useMemo(
    () =>
      swipeActions.secondary === "snooze"
        ? {
            accessibilityLabel: `Choose when to snooze ${displayTitle}`,
            icon: "clock" as const,
            label: "Snooze",
            menu: {
              actions: snoozePresetActions,
              onPressAction: handleMenuAction,
              title: "Snooze until",
            },
            onPress: () => undefined,
          }
        : null,
    [handleMenuAction, snoozePresetActions, swipeActions.secondary, displayTitle],
  );
  const accessibilityActions = useMemo(
    () => threadRowAccessibilityActions(menuActions, canOperateThread),
    [canOperateThread, menuActions],
  );

  const trailingTextClassName = selected
    ? selectedThreadRowColors.foregroundClassName
    : rowAppearance.tertiaryForegroundClassName;
  // Every row draws at full strength; status labels and the unread dot carry
  // state. Sidebar rows use navigation foregrounds on their active and idle
  // surfaces.
  const child = thread.lineage.relationshipToParent === "subagent";
  const needsCount =
    Number(thread.hasPendingApprovals) + Number(thread.hasPendingUserInput) ||
    (thread.pendingSubagentRequest != null || status === "failed" || status === "limited" ? 1 : 0);
  const rowBody = discord ? (
    <View
      style={{
        minHeight: child ? 38 : 44,
        paddingHorizontal: 10,
        marginLeft: child
          ? thread.lineage.rootThreadId === thread.lineage.parentThreadId
            ? 26
            : 42
          : 0,
        flexDirection: "row",
        alignItems: "center",
        gap: 9,
        borderRadius: 4,
        backgroundColor: selected ? theme["--color-thread-selected"] : theme["--color-drawer"],
      }}
    >
      {child ? (
        <View
          style={{
            position: "absolute",
            left: -12,
            top: 0,
            height: 20,
            width: 15,
            borderLeftWidth: 1,
            borderBottomWidth: 1,
            borderBottomLeftRadius: 8,
            borderColor: theme["--color-border"],
          }}
        />
      ) : null}
      {isUnread ? (
        <View
          style={{
            position: "absolute",
            left: -5,
            width: 5,
            height: 8,
            borderRadius: 3,
            backgroundColor: theme["--color-foreground"],
          }}
        />
      ) : null}
      {child ? (
        <SymbolView name="bubble.left" size={17} tintColorClassName="accent-foreground-muted" />
      ) : (
        <Text className="text-foreground-muted" style={{ fontSize: 26, width: 22 }}>
          #
        </Text>
      )}
      <Text
        numberOfLines={1}
        className={cn(
          "min-w-0 flex-1",
          isUnread || needsCount
            ? "text-foreground font-t3-bold"
            : "text-foreground-muted font-t3-medium",
        )}
        style={{ fontSize: child ? 14 : 16, fontWeight: isUnread || needsCount ? "600" : "500" }}
      >
        {displayTitle}
      </Text>
      {thread.source.comparison ? (
        <Text
          className="text-xs text-foreground-muted"
          accessibilityLabel={`${thread.source.comparison.threadIds.length} ${thread.source.comparison.threadIds.length === 1 ? "model" : "models"}`}
        >
          {thread.source.comparison.threadIds.length}{" "}
          {thread.source.comparison.threadIds.length === 1 ? "model" : "models"}
        </Text>
      ) : null}
      {status === "working" ? (
        <View
          style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: "#23A55A" }}
          accessibilityLabel="Working"
        />
      ) : status === "connecting" || status === "reconnecting" || status === "offline" ? (
        <Text className="text-xs text-foreground-muted">
          {STATUS_LABEL_BY_STATUS[status]?.label}
        </Text>
      ) : null}
      {needsCount > 0 ? (
        <View
          accessibilityLabel={`${needsCount} need you`}
          style={{
            minWidth: 20,
            paddingHorizontal: 5,
            borderRadius: 10,
            backgroundColor: "#F23F43",
            alignItems: "center",
          }}
        >
          <Text style={{ fontSize: 12, fontWeight: "700", color: "#FFFFFF" }}>{needsCount}</Text>
        </View>
      ) : null}
      {props.searchMatch && !privacy ? (
        <SymbolView name="magnifyingglass" size={12} tintColorClassName="accent-foreground-muted" />
      ) : null}
    </View>
  ) : (
    <View className="flex-row items-center gap-3">
      {paint ? <SessionBoxPainting box={paint} size={ROW_PAINTING_SIZE} /> : null}
      <View className="min-w-0 flex-1">
        <View className="flex-row items-start gap-2">
          <Text
            className={cn(
              "min-w-0 flex-1 text-base font-t3-medium",
              selected
                ? selectedThreadRowColors.foregroundClassName
                : rowAppearance.foregroundClassName,
            )}
            numberOfLines={2}
          >
            {displayTitle}
          </Text>
          {/* Centered on the title's first line. */}
          <View className="flex-row items-center gap-1.5 pt-[3px]">
            {thread.source.comparison ? (
              <Text
                className="text-xs text-foreground-muted"
                accessibilityLabel={`${thread.source.comparison.threadIds.length} ${thread.source.comparison.threadIds.length === 1 ? "model" : "models"}`}
              >
                {thread.source.comparison.threadIds.length}{" "}
                {thread.source.comparison.threadIds.length === 1 ? "model" : "models"}
              </Text>
            ) : null}
            {props.hasQueuedMessages ? <QueuedMessageIcon selected={selected} /> : null}
            {pinnedRow ? (
              <SymbolView
                name="pin"
                size={11}
                tintColorClassName={rowAppearance.mutedIconTintClassName}
                type="monochrome"
              />
            ) : null}
            {snoozeWakeLabelText !== undefined ? (
              <View className="flex-row items-center gap-1">
                <SymbolView
                  name="clock"
                  size={11}
                  tintColorClassName={
                    selected
                      ? selectedThreadRowColors.iconTintClassName
                      : rowAppearance.tertiaryIconTintClassName
                  }
                  type="monochrome"
                />
                <Text className={cn("text-xs tabular-nums", trailingTextClassName)}>
                  {snoozeWakeLabelText}
                </Text>
              </View>
            ) : status === "working" ? (
              <WorkingThreadRowStatus
                startedAt={resolveThreadWorkingStartedAt(thread)}
                lastActivityAt={resolveThreadLastActivityAt(thread)}
                active={!dormant}
                selected={selected}
              />
            ) : rowStatusText ? (
              <Text
                className={cn(
                  "text-xs tabular-nums",
                  needsYou
                    ? selected
                      ? selectedThreadRowColors.foregroundClassName
                      : (statusLabel?.className ?? "text-warning-foreground")
                    : trailingTextClassName,
                )}
                numberOfLines={1}
              >
                {rowStatusText}
              </Text>
            ) : (
              <>
                {isUnread ? <UnreadDot /> : null}
                <Text className={cn("text-xs tabular-nums", trailingTextClassName)}>
                  {timeLabel}
                </Text>
              </>
            )}
          </View>
        </View>
        {props.searchMatch && !privacy ? (
          <View className="mt-1">
            <ThreadSearchMatchExcerpt
              sidebar={sidebarPane}
              match={props.searchMatch}
              query={props.searchQuery ?? ""}
              selected={selected}
            />
          </View>
        ) : null}
        <View className="mt-1 flex-row items-center gap-2">
          {(status === "failed" || status === "limited") && thread.runtime?.lastError ? (
            <Text
              className={cn(
                "flex-1 text-xs",
                selected
                  ? selectedThreadRowColors.mutedForegroundClassName
                  : status === "limited"
                    ? "text-warning-foreground"
                    : "text-danger-foreground",
              )}
              numberOfLines={1}
            >
              {thread.runtime.lastError}
            </Text>
          ) : preview && !props.searchMatch ? (
            <Text
              className={cn(
                "min-w-0 flex-1 text-[13px]",
                selected
                  ? selectedThreadRowColors.mutedForegroundClassName
                  : rowAppearance.mutedForegroundClassName,
              )}
              numberOfLines={1}
            >
              {preview.text}
            </Text>
          ) : (
            <View className="flex-1" />
          )}
          {pr ? (
            <View
              className="flex-row items-center gap-1"
              accessibilityLabel={pr.accessibilityLabel}
            >
              <SymbolView
                name={pr.kind === "stack" ? "square.3.layers.3d" : "arrow.triangle.pull"}
                size={12}
                tintColorClassName={
                  pr.state === null || pr.isDraft
                    ? rowAppearance.mutedIconTintClassName
                    : pr.state === "open"
                      ? "accent-adaptive-emerald-600-400"
                      : pr.state === "closed"
                        ? "accent-adaptive-rose-600-400"
                        : "accent-adaptive-violet-600-400"
                }
              />
              <Text
                accessibilityLabel={pr.accessibilityLabel}
                className={cn("text-xs", pr.textClassName)}
                style={{ fontFamily: MONO_FONT }}
              >
                {pr.label}
              </Text>
            </View>
          ) : null}
          {providerInstance ? (
            // Only the provider the chat is on now: an earlier one drawn behind it read as
            // if both were running. The account badge keeps same-driver instances distinct.
            <View className="flex-row items-center">
              <ProviderInstanceIcon
                iconUrl={providerIconUrl}
                provider={providerInstance.driverKind}
                size={14}
                displayName={providerInstance.displayName}
                accentColor={providerInstance.accentColor}
                showBadge={providerInstance.showBadge}
                surfaceColor={rowAppearance.providerIconSurfaceColor}
              />
              {providerNameLabel ? (
                <Text
                  className={cn(
                    "ml-1.5 min-w-0 text-xs",
                    selected
                      ? selectedThreadRowColors.mutedForegroundClassName
                      : rowAppearance.tertiaryForegroundClassName,
                  )}
                  ellipsizeMode="middle"
                  numberOfLines={1}
                  style={{ maxWidth: 140 }}
                >
                  {providerNameLabel}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );

  // A saved row of a machine that is offline is laid out exactly like a live one: it
  // used to lose this inset and its divider, so its icon ran off the screen's edge.
  const rowInner =
    discord || sidebarPane ? (
      rowBody
    ) : (
      /* Flat native list rows: no tonal containers — colored status
         labels and text hierarchy carry state, an inset hairline
         separates rows. The opaque screen background stays so swipe
         actions reveal behind the row. */
      <View>
        <View className={THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME}>{rowBody}</View>
        {THREAD_LIST_V2_ROW_DIVIDERS && props.showTrailingDivider !== false ? (
          <View className="ml-[68px] h-px bg-border-subtle" />
        ) : null}
      </View>
    );

  const rowContent = (close: () => void) => (
    <RowPressable
      key={`${thread.environmentId}:${thread.id}`}
      interactionClassName={rowAppearance.interactionClassName}
      interactionOpacity={rowAppearance.interactionOpacity}
      className={discord ? "mx-2 my-px" : rowAppearance.className}
      accessibilityHint="Opens the chat"
      accessibilityLabel={threadRowAccessibilityLabel({
        title: displayTitle,
        ...(providerNameLabel ? { providerName: providerNameLabel } : {}),
        status,
        goalActive: thread.goal?.status === "active",
        unread: isUnread,
        queued: props.hasQueuedMessages === true,
        pinned: pinnedRow,
        settled: props.settled === true,
        snoozed: snoozedRow,
        wakeLabel: snoozeWakeLabelText,
        pullRequestLabel: pr?.accessibilityLabel,
      })}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={({ nativeEvent }) => {
        if (!accessibilityActions.some((action) => action.name === nativeEvent.actionName)) return;
        close();
        handleMenuAction({ nativeEvent: { event: nativeEvent.actionName } });
      }}
      onPressIn={() => preloadPhoneThread(thread.environmentId, thread.id)}
      onPress={() => {
        close();
        if (discord) void DiscordHaptics.impactAsync(DiscordHaptics.ImpactFeedbackStyle.Light);
        onSelectThread(thread);
      }}
      style={discord ? { backgroundColor: theme["--color-drawer"] } : rowAppearance.cardStyle}
    >
      {rowInner}
    </RowPressable>
  );

  if (props.readOnly)
    return (
      <View
        accessible
        accessibilityLabel={
          providerNameLabel ? `${displayTitle}, ${providerNameLabel}` : displayTitle
        }
        accessibilityState={{ disabled: true }}
        className={discord ? "mx-2 my-px" : rowAppearance.className}
        style={discord ? { backgroundColor: theme["--color-drawer"] } : rowAppearance.cardStyle}
      >
        {rowInner}
      </View>
    );
  if (!canOperateThread) return rowContent(() => {});

  return (
    <View collapsable={false}>
      {customSnoozeOpen && (
        <CustomSnoozeSheet onClose={() => setCustomSnoozeOpen(false)} onSnooze={handleSnooze} />
      )}
      <ThreadSwipeable
        dormant={dormant}
        threadKey={`${thread.environmentId}:${thread.id}`}
        backgroundColor={discord ? theme["--color-drawer"] : rowAppearance.swipeBackgroundColor}
        containerStyle={rowAppearance.swipeContainerStyle}
        enableTrackpadSwipe
        // Full swipe commits the advertised primary action (Archive / Wake),
        // never the secondary snooze action.
        fullSwipeAction="primary"
        fullSwipeWidth={
          props.fullSwipeWidth !== undefined
            ? props.fullSwipeWidth - (discord ? 72 : 0)
            : windowWidth - (discord ? 88 : 32)
        }
        onDelete={handleDelete}
        onSwipeableClose={props.onSwipeableClose}
        onSwipeableWillOpen={props.onSwipeableWillOpen}
        primaryAction={primaryAction}
        secondaryAction={secondaryAction}
        resetKey={threadListV2SwipeResetKey({
          thread,
          snoozed: snoozedRow,
          settled: props.settled === true,
        })}
        simultaneousWith={props.simultaneousSwipeGesture}
        threadTitle={displayTitle}
      >
        {(close) => (
          <ControlPillMenu
            actions={menuActions}
            onPressAction={handleMenuAction}
            shouldOpenOnLongPress
          >
            {rowContent(close)}
          </ControlPillMenu>
        )}
      </ThreadSwipeable>
    </View>
  );
});
