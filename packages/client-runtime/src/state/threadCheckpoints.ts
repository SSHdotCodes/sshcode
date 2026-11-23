import type {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  OrchestrationV2Checkpoint,
  OrchestrationV2ThreadProjection,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** How "edit and resend" rewinds to before a user message. */
export interface MessageRewindPlan {
  /** Run ordinal to roll back to: the run before the message's own run. */
  readonly turnCount: number;
  /** False when the workspace has no git checkpoints, so only the conversation rewinds. */
  readonly canRestoreFiles: boolean;
  /** The message is the latest prompt and its run was stopped. */
  readonly stoppedLatestRun: boolean;
  /**
   * The provider rewinds by starting a new session that forgets the whole
   * earlier conversation, so the confirmation must say so.
   */
  readonly startsNewSession: boolean;
  /**
   * A stopped latest run that changed no files: there is nothing to confirm.
   * Never true when the rewind starts a new session.
   */
  readonly skipConfirmation: boolean;
}

/** Confirmation sentence for a rewind that starts a new provider session. */
export const REWIND_STARTS_NEW_SESSION_NOTICE =
  "This agent cannot rewind a chat: it starts a new session and forgets the earlier conversation.";

/** Whether the active provider session rewinds by starting a new session. */
function activeRollbackStartsNewSession(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "providerThreads" | "providerSessions"
  >,
): boolean {
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === projection.thread.activeProviderThreadId,
  );
  if (providerThread === undefined || providerThread.providerSessionId === null) return false;
  const session = projection.providerSessions.find(
    (candidate) => candidate.id === providerThread.providerSessionId,
  );
  return session?.capabilities.threads.rollbackStartsNewSession === true;
}

/** A checkpoint a rewind can target. `missing` means no git: conversation only. */
function isRewindableCheckpointStatus(status: OrchestrationV2Checkpoint["status"]): boolean {
  return status === "ready" || status === "missing";
}

function isFileActivityItem(item: { readonly type: string; readonly runId: RunId | null }) {
  return item.type === "file_change" || item.type === "command_execution";
}

/**
 * Plans rewinding the conversation to before the user message that started
 * `runId`, or null when no usable checkpoint exists for it. Shared by web and
 * mobile so both offer the same choices.
 */
export function deriveMessageRewindPlan(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    | "runs"
    | "checkpoints"
    | "turnItems"
    | "visibleTurnItems"
    | "thread"
    | "providerThreads"
    | "providerSessions"
  >,
  runId: RunId,
): MessageRewindPlan | null {
  const run = projection.runs.find((candidate) => candidate.id === runId);
  if (run === undefined || run.status === "rolled_back" || run.ordinal < 1) return null;
  const source = projection.checkpoints.find(
    (candidate) => candidate.runId === run.id && isRewindableCheckpointStatus(candidate.status),
  );
  if (source === undefined || source.appRunOrdinal === null) return null;
  const turnCount = Math.max(0, source.appRunOrdinal - 1);
  let target: OrchestrationV2Checkpoint | undefined;
  for (let index = projection.checkpoints.length - 1; index >= 0; index--) {
    const candidate = projection.checkpoints[index]!;
    const matches =
      turnCount === 0
        ? candidate.ordinalWithinScope === 0 && candidate.appRunOrdinal === null
        : candidate.appRunOrdinal === turnCount;
    if (matches) {
      target = candidate;
      break;
    }
  }
  if (target === undefined || !isRewindableCheckpointStatus(target.status)) return null;
  const isLatestRun = projection.runs.every(
    (candidate) => candidate.ordinal <= run.ordinal || candidate.status === "rolled_back",
  );
  // A git checkpoint lists exactly what the run changed. Without git, any
  // edit or shell command the run started may have touched files.
  const changedNoFiles =
    source.status === "ready"
      ? source.files.length === 0
      : !projection.turnItems.some((item) => item.runId === run.id && isFileActivityItem(item)) &&
        !projection.visibleTurnItems.some(
          ({ item }) => item.runId === run.id && isFileActivityItem(item),
        );
  const stoppedLatestRun = run.status === "interrupted" && isLatestRun;
  const startsNewSession = activeRollbackStartsNewSession(projection);
  return {
    turnCount,
    canRestoreFiles: target.status === "ready",
    stoppedLatestRun,
    startsNewSession,
    skipConfirmation: stoppedLatestRun && changedNoFiles && !startsNewSession,
  };
}

export function sameMessageRewindPlan(
  left: MessageRewindPlan | null,
  right: MessageRewindPlan | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.turnCount === right.turnCount &&
      left.canRestoreFiles === right.canRestoreFiles &&
      left.stoppedLatestRun === right.stoppedLatestRun &&
      left.startsNewSession === right.startsNewSession &&
      left.skipConfirmation === right.skipConfirmation)
  );
}

export interface ThreadCheckpointSummary {
  readonly checkpointId?: CheckpointId;
  readonly scopeId?: CheckpointScopeId;
  readonly runId: RunId;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
  readonly status: "ready" | "missing" | "error" | "stale";
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly kind: string;
    readonly additions: number;
    readonly deletions: number;
  }>;
  readonly assistantMessageId: MessageId | null;
  readonly completedAt: string;
}

/** Derives the checkpoint/diff rows needed by review UIs from native V2 entities. */
export function deriveThreadCheckpointSummaries(
  projection: Pick<OrchestrationV2ThreadProjection, "checkpoints" | "messages">,
): ReadonlyArray<ThreadCheckpointSummary> {
  let assistantMessageIdsByRun: Map<RunId, MessageId | null | undefined> | undefined;
  let nextMessageIndex = -1;
  return projection.checkpoints.flatMap((checkpoint) => {
    if (checkpoint.appRunOrdinal === null || checkpoint.runId === null) return [];
    const messages = projection.messages;
    if (assistantMessageIdsByRun === undefined) {
      assistantMessageIdsByRun = new Map();
      for (const entry of projection.checkpoints) {
        if (entry.appRunOrdinal !== null && entry.runId !== null) {
          assistantMessageIdsByRun.set(entry.runId, undefined);
        }
      }
      nextMessageIndex = messages.length - 1;
    }
    // Resume the reverse scan only as far as this checkpoint needs. Recent
    // checkpoints must not force a traversal of unrelated older history.
    while (nextMessageIndex >= 0 && assistantMessageIdsByRun.get(checkpoint.runId) === undefined) {
      const message = messages[nextMessageIndex--]!;
      const { runId, role } = message;
      if (
        role === "assistant" &&
        runId !== null &&
        assistantMessageIdsByRun.has(runId) &&
        assistantMessageIdsByRun.get(runId) === undefined
      ) {
        assistantMessageIdsByRun.set(runId, message.id ?? null);
      }
    }
    const assistantMessageId = assistantMessageIdsByRun.get(checkpoint.runId) ?? null;
    return [
      {
        checkpointId: checkpoint.id,
        scopeId: checkpoint.scopeId,
        runId: checkpoint.runId,
        checkpointTurnCount: checkpoint.appRunOrdinal,
        checkpointRef: checkpoint.ref,
        status: checkpoint.status,
        files: checkpoint.files,
        assistantMessageId,
        completedAt: DateTime.formatIso(checkpoint.capturedAt),
      },
    ];
  });
}
