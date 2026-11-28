import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import {
  isRoutineTeamBoardNote,
  isTeamBoardNoteMessageId,
  noticeSummary,
} from "@t3tools/shared/teamBoardNote";
import { notificationMessageId } from "./restartNotice.ts";

export interface TeamBoardNote {
  readonly summary: string;
  /** The routine opening note: the board pill already shows it, so it gets no row. */
  readonly routine: boolean;
}

/**
 * A team board note in a chat, never something the person said. New notes are notification rows;
 * chats recorded earlier hold them as `user_message` items whose message id starts `team-board:`.
 */
export function teamBoardNote(item: OrchestrationV2TurnItem): TeamBoardNote | undefined {
  if (item.type === "notification") {
    const messageId = notificationMessageId(item.id);
    if (messageId === null || !isTeamBoardNoteMessageId(messageId)) return undefined;
    return { summary: item.summary, routine: isRoutineTeamBoardNote(messageId) };
  }
  if (item.type !== "user_message" || !isTeamBoardNoteMessageId(item.messageId)) return undefined;
  return {
    summary: noticeSummary(item.text),
    routine: isRoutineTeamBoardNote(item.messageId, item.text),
  };
}

/** A legacy board note as the notification row it would be recorded as today. */
export function teamBoardNoteAsNotification(
  item: OrchestrationV2TurnItem,
  note: TeamBoardNote,
): Extract<OrchestrationV2TurnItem, { type: "notification" }> | undefined {
  if (item.type === "notification") return item;
  if (item.type !== "user_message") return undefined;
  const {
    type: _type,
    messageId: _messageId,
    inputIntent: _inputIntent,
    text: _text,
    textOmitted: _textOmitted,
    context: _context,
    attachments: _attachments,
    createdBy: _createdBy,
    creationSource: _creationSource,
    scheduledTaskId: _scheduledTaskId,
    agentWasWaiting: _agentWasWaiting,
    senderThreadId: _senderThreadId,
    notifySenderOnCompletion: _notify,
    ...base
  } = item;
  return {
    ...base,
    type: "notification",
    source: { kind: "system" },
    outcome: "updated",
    summary: note.summary,
  };
}
