import type { SteerWait } from "@t3tools/client-runtime/state/steer-wait";
import type { MessageId, RunId } from "@t3tools/contracts";
import type { discordAvatarIdentity } from "@t3tools/shared/discordProfile";
import { useRef, useSyncExternalStore } from "react";
import { isContextCompactionActivityGroup } from "../../lib/threadActivity";
import type { PendingThreadFeedEntry } from "../../state/pending-thread-feed";
import type { createTimelineDecorationsProjector } from "../discord/timelinePresentation";
import type { WorktreeSetupCardProps } from "./worktree-setup-card";

export interface ThreadFeedRowStoreState {
  readonly copiedRowId: string | null;
  readonly searchJumpRowId: string | null;
  readonly expandedWorkRows: Record<string, boolean>;
  readonly editingMessageId?: MessageId | null;
  readonly editingQueuedMessageIds?: Readonly<Record<MessageId, true>>;
  readonly dispatchingMessageId: MessageId | null;
  readonly steerWait: SteerWait | null;
  readonly unsettledTurnId: RunId | null;
  readonly terminalAssistantMessageIds: ReadonlySet<string>;
  readonly failedRunIds: ReadonlySet<RunId>;
  readonly decorations: ReturnType<ReturnType<typeof createTimelineDecorationsProjector>>;
  readonly agentAvatars: ReadonlyMap<string, ReturnType<typeof discordAvatarIdentity>> | undefined;
  readonly worktreeSetup: WorktreeSetupCardProps | null;
  readonly setupWorkingStartedAt: string | null;
  readonly setupAnchorRowId: string | null;
  readonly messageRunActive: boolean;
  readonly disclosureToggleSettling: boolean;
}

export interface ThreadFeedRowStore {
  getSnapshot(): ThreadFeedRowStoreState;
  commitSnapshot(next: ThreadFeedRowStoreState): void;
  subscribe(listener: () => void): () => void;
}

function sameRowStoreState(a: ThreadFeedRowStoreState, b: ThreadFeedRowStoreState): boolean {
  return (
    a.copiedRowId === b.copiedRowId &&
    a.searchJumpRowId === b.searchJumpRowId &&
    a.expandedWorkRows === b.expandedWorkRows &&
    a.editingMessageId === b.editingMessageId &&
    a.editingQueuedMessageIds === b.editingQueuedMessageIds &&
    a.dispatchingMessageId === b.dispatchingMessageId &&
    a.steerWait === b.steerWait &&
    a.unsettledTurnId === b.unsettledTurnId &&
    a.terminalAssistantMessageIds === b.terminalAssistantMessageIds &&
    a.failedRunIds === b.failedRunIds &&
    a.decorations === b.decorations &&
    a.agentAvatars === b.agentAvatars &&
    a.worktreeSetup === b.worktreeSetup &&
    a.setupWorkingStartedAt === b.setupWorkingStartedAt &&
    a.setupAnchorRowId === b.setupAnchorRowId &&
    a.messageRunActive === b.messageRunActive &&
    a.disclosureToggleSettling === b.disclosureToggleSettling
  );
}

export function createThreadFeedRowStore(initial: ThreadFeedRowStoreState): ThreadFeedRowStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    commitSnapshot: (next) => {
      if (sameRowStoreState(state, next)) return;
      state = next;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export interface ThreadFeedRowVolatileSlice {
  readonly decorationDay: string | null;
  readonly decorationIsNew: boolean;
  readonly decorationGrouped: boolean;
  readonly avatar: ReturnType<typeof discordAvatarIdentity> | undefined;
  readonly copiedRowId: string | null;
  readonly searchJumpHighlighted: boolean;
  readonly expandedRowsKey: string;
  readonly userMessageExpanded: boolean;
  readonly isEditingUserMessage: boolean;
  readonly isDispatching: boolean;
  readonly steerWait: SteerWait | null;
  readonly isUnsettledTurn: boolean;
  readonly isTerminalAssistant: boolean;
  readonly isFailedRun: boolean;
  readonly worktreeSetup: WorktreeSetupCardProps | null;
  readonly setupWorkingStartedAt: string | null;
  readonly messageRunActive: boolean;
}

export function userMessageExpansionKey(messageId: MessageId): string {
  return `user-message:${messageId}`;
}

export function selectRowVolatileSlice(
  state: ThreadFeedRowStoreState,
  item: PendingThreadFeedEntry,
): ThreadFeedRowVolatileSlice {
  const decoration = state.decorations.get(item.id);
  const isMessage = item.type === "message";
  const isAssistantMessage = isMessage && item.message.role === "assistant";
  const isActivityGroup = item.type === "activity-group";
  let copiedRowId: string | null = null;
  let expandedRowsKey = "";
  if (isActivityGroup) {
    for (let i = 0; i < item.activities.length; i++) {
      const activityId = item.activities[i]!.id;
      if (state.copiedRowId === activityId) {
        copiedRowId = activityId;
      }
      expandedRowsKey += state.expandedWorkRows[activityId] ? "1" : "0";
    }
  }
  const isSetupAnchor = state.setupAnchorRowId !== null && item.id === state.setupAnchorRowId;
  return {
    decorationDay: decoration?.day ?? null,
    decorationIsNew: decoration?.isNew ?? false,
    decorationGrouped: decoration?.grouped ?? false,
    avatar: isMessage ? state.agentAvatars?.get(item.message.runId ?? "") : undefined,
    copiedRowId,
    searchJumpHighlighted: state.searchJumpRowId === item.id,
    expandedRowsKey,
    userMessageExpanded:
      isMessage &&
      item.message.role === "user" &&
      (state.expandedWorkRows[userMessageExpansionKey(item.message.id)] ?? false),
    isEditingUserMessage:
      isMessage &&
      (item.message.id === state.editingMessageId ||
        state.editingQueuedMessageIds?.[item.message.id] === true),
    isDispatching:
      isMessage &&
      item.pendingMessage !== undefined &&
      item.pendingMessage.messageId === state.dispatchingMessageId,
    steerWait: isMessage && state.steerWait?.messageId === item.message.id ? state.steerWait : null,
    isUnsettledTurn:
      state.unsettledTurnId !== null &&
      ((isAssistantMessage && item.message.runId === state.unsettledTurnId) ||
        (isActivityGroup &&
          isContextCompactionActivityGroup(item) &&
          item.runId === state.unsettledTurnId)),
    isTerminalAssistant:
      isAssistantMessage && state.terminalAssistantMessageIds.has(item.message.id),
    isFailedRun:
      isAssistantMessage &&
      item.message.runId !== null &&
      state.failedRunIds.has(item.message.runId),
    worktreeSetup: isSetupAnchor ? state.worktreeSetup : null,
    setupWorkingStartedAt: isSetupAnchor ? state.setupWorkingStartedAt : null,
    messageRunActive:
      isMessage && item.message.projectedItem !== undefined && state.messageRunActive,
  };
}

export function sameRowVolatileSlice(
  a: ThreadFeedRowVolatileSlice,
  b: ThreadFeedRowVolatileSlice,
): boolean {
  return (
    a.decorationDay === b.decorationDay &&
    a.decorationIsNew === b.decorationIsNew &&
    a.decorationGrouped === b.decorationGrouped &&
    a.avatar === b.avatar &&
    a.copiedRowId === b.copiedRowId &&
    a.searchJumpHighlighted === b.searchJumpHighlighted &&
    a.expandedRowsKey === b.expandedRowsKey &&
    a.userMessageExpanded === b.userMessageExpanded &&
    a.isEditingUserMessage === b.isEditingUserMessage &&
    a.isDispatching === b.isDispatching &&
    a.steerWait === b.steerWait &&
    a.isUnsettledTurn === b.isUnsettledTurn &&
    a.isTerminalAssistant === b.isTerminalAssistant &&
    a.isFailedRun === b.isFailedRun &&
    a.worktreeSetup === b.worktreeSetup &&
    a.setupWorkingStartedAt === b.setupWorkingStartedAt &&
    a.messageRunActive === b.messageRunActive
  );
}

/**
 * Subscribe a single list row to only its own volatile slice so per-row
 * interactions (copy feedback, work-row expansion, steer wait, worktree setup,
 * turn settlement) never re-render unrelated rows.
 */
export function useThreadFeedRowVolatileSlice(
  rowStore: ThreadFeedRowStore,
  item: PendingThreadFeedEntry,
): ThreadFeedRowVolatileSlice {
  const sliceCacheRef = useRef<ThreadFeedRowVolatileSlice | null>(null);

  const getSlice = () => {
    const next = selectRowVolatileSlice(rowStore.getSnapshot(), item);
    const cached = sliceCacheRef.current;
    if (cached && sameRowVolatileSlice(cached, next)) {
      return cached;
    }
    sliceCacheRef.current = next;
    return next;
  };

  return useSyncExternalStore(rowStore.subscribe, getSlice, getSlice);
}
