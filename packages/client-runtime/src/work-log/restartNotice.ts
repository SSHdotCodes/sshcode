import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

const RESTART_NOTICE_SUFFIX = ":signal:server-restart";
const RESTART_CONTINUATION_PREFIX = "message:restart-continuation:";
const MESSAGE_ITEM_PREFIX = "turn-item:message:";

/** The message id a notification row was made from: `turn-item:message:<encoded message id>`. */
function notificationMessageId(itemId: string): string | null {
  if (!itemId.startsWith(MESSAGE_ITEM_PREFIX)) return null;
  try {
    return decodeURIComponent(itemId.slice(MESSAGE_ITEM_PREFIX.length));
  } catch {
    return null;
  }
}

/**
 * Restart notices ("The server shut down before this turn finished.") on turns SSHCode then
 * resumed. The resume row ("SSHCode restarted and resumed this turn") already says what
 * happened, so these notices are hidden; a turn left cut keeps its notice.
 */
export function resumedRestartNoticeIds(
  items: Iterable<{ readonly item: OrchestrationV2TurnItem }>,
): ReadonlySet<string> {
  const continuedRunIds = new Set<string>();
  const notices: Array<{ readonly id: string; readonly runId: string }> = [];
  for (const { item } of items) {
    // The resume shows as a notification row made from its message.
    const messageId =
      item.type === "notification"
        ? notificationMessageId(item.id)
        : item.type === "user_message"
          ? item.messageId
          : null;
    if (messageId?.startsWith(RESTART_CONTINUATION_PREFIX)) {
      continuedRunIds.add(messageId.slice(RESTART_CONTINUATION_PREFIX.length));
    } else if (
      item.type === "system_notice" &&
      item.runId !== null &&
      item.id.endsWith(RESTART_NOTICE_SUFFIX)
    ) {
      notices.push({ id: item.id, runId: item.runId });
    }
  }
  return new Set(notices.filter(({ runId }) => continuedRunIds.has(runId)).map(({ id }) => id));
}
