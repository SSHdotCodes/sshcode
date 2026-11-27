import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const RESTART_NOTICE_SUFFIX = ":signal:server-restart";
const RESTART_CONTINUATION_PREFIX = "message:restart-continuation:";
const MESSAGE_ITEM_PREFIX = "turn-item:message:";
/** A wake that starts this soon after the cut carried the chat on, like a resume. */
const WAKE_CONTINUES_WITHIN_MS = 5 * 60_000;

/** The message id a notification row was made from: `turn-item:message:<encoded message id>`. */
export function notificationMessageId(itemId: string): string | null {
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
 * happened, so these notices are hidden. A wake queued before the restart (a saved key, a
 * monitor) runs in place of the resume and carries the chat on, so it hides the notice too;
 * a turn left cut keeps its notice.
 */
export function resumedRestartNoticeIds(
  items: Iterable<{ readonly item: OrchestrationV2TurnItem }>,
): ReadonlySet<string> {
  const continuedRunIds = new Set<string>();
  const notices: Array<{ readonly id: string; readonly runId: string; readonly item: Item }> = [];
  const ordered: Item[] = [];
  for (const { item } of items) {
    ordered.push(item);
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
      notices.push({ id: item.id, runId: item.runId, item });
    }
  }
  return new Set(
    notices
      .filter(
        ({ runId, item }) => continuedRunIds.has(runId) || wakeCarriedOn(item, runId, ordered),
      )
      .map(({ id }) => id),
  );
}

type Item = OrchestrationV2TurnItem;

function itemAtMs(item: Item): number | null {
  const at = item.startedAt ?? item.updatedAt;
  return at == null ? null : DateTime.toEpochMillis(at);
}

/** The item right after the notice is a later run's wake that started soon after the cut. */
function wakeCarriedOn(notice: Item, runId: string, ordered: ReadonlyArray<Item>): boolean {
  if (typeof notice.ordinal !== "number") return false;
  let next: Item | undefined;
  for (const item of ordered) {
    if (
      typeof item.ordinal === "number" &&
      item.ordinal > notice.ordinal &&
      (next === undefined || item.ordinal < next.ordinal)
    ) {
      next = item;
    }
  }
  if (next === undefined || next.type !== "notification" || next.runId === runId) return false;
  const cutAt = itemAtMs(notice);
  const wakeAt = itemAtMs(next);
  return cutAt !== null && wakeAt !== null && wakeAt - cutAt <= WAKE_CONTINUES_WITHIN_MS;
}
