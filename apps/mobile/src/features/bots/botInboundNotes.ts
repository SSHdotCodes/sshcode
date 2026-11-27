import { notificationMessageId } from "@t3tools/client-runtime/work-log/restart-notice";
import { BOT_EVENT_PHRASES, botInboundNote } from "@t3tools/client-runtime/state/bots";
import type { BotWakeItem } from "@t3tools/shared/bots";

/** One inbound line in a bot chat: a muted pill, maybe linking a chat, and its text below. */
export interface BotInboundLine {
  readonly key: string;
  readonly pill: string;
  readonly threadId: string | null;
  readonly text: string | null;
}

function inboundLine(item: BotWakeItem, index: number): BotInboundLine {
  switch (item.kind) {
    case "event":
      return {
        key: `${index}:${item.threadId}`,
        pill: `${item.title} ${BOT_EVENT_PHRASES[item.event]}${item.count && item.count > 1 ? ` (${item.count})` : ""}`,
        threadId: item.threadId,
        text: item.detail ?? null,
      };
    case "message":
      return {
        key: `${index}:${item.threadId}`,
        pill: `From ${item.title}`,
        threadId: item.threadId,
        text: item.text,
      };
    case "routine":
      return { key: `${index}:routine`, pill: "Missed routine", threadId: null, text: item.text };
  }
}

const parsed = new Map<string, ReadonlyArray<BotInboundLine> | null>();

/**
 * The notes SSHCode posts into a bot chat (watched chat updates, messages from other chats,
 * "Send to <bot>…") as lines to draw, or null for an ordinary message. Parsed once per text.
 */
export function botInboundLines(text: string): ReadonlyArray<BotInboundLine> | null {
  const cached = parsed.get(text);
  if (cached !== undefined) return cached;
  const items = botInboundNote(text);
  const lines = items === null || items.length === 0 ? null : items.map(inboundLine);
  if (parsed.size > 500) parsed.clear();
  parsed.set(text, lines);
  return lines;
}

/**
 * The message a bot's wake note was posted as, from its notification row's id
 * (`turn-item:message:<message:bot:…>`), or null for any other notification.
 */
export function botWakeMessageId(itemId: string): string | null {
  const messageId = notificationMessageId(itemId);
  return messageId?.startsWith("message:bot:") ? messageId : null;
}
