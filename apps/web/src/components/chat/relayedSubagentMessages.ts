import {
  decodeRelayedSubagentMessages,
  recentRelayedSubagentMessages,
  relayedSubagentMessagesStorageKey,
  type RelayedSubagentMessage,
} from "@t3tools/client-runtime/state/thread-execution";
import { useSyncExternalStore } from "react";

/**
 * What this device sent to provider subagents through their parents. The
 * provider owns a subagent's conversation, so the message lives in the parent
 * chat; the subagent chat shows this device's copy so you can see it went.
 */
const EMPTY: ReadonlyArray<RelayedSubagentMessage> = [];
const listeners = new Set<() => void>();
const cache = new Map<string, ReadonlyArray<RelayedSubagentMessage>>();

export function readRelayedSubagentMessages(
  threadId: string,
): ReadonlyArray<RelayedSubagentMessage> {
  const cached = cache.get(threadId);
  if (cached !== undefined) return cached;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(relayedSubagentMessagesStorageKey(threadId));
  } catch {
    // Without storage the copy lasts for this session.
  }
  const messages = recentRelayedSubagentMessages(decodeRelayedSubagentMessages(raw), Date.now());
  cache.set(threadId, messages);
  return messages;
}

export function rememberRelayedSubagentMessage(threadId: string, text: string): void {
  const now = Date.now();
  const messages = recentRelayedSubagentMessages(
    [...readRelayedSubagentMessages(threadId), { text, sentAt: now }],
    now,
  );
  cache.set(threadId, messages);
  try {
    window.localStorage.setItem(
      relayedSubagentMessagesStorageKey(threadId),
      JSON.stringify(messages),
    );
  } catch {
    // Kept in memory for this session.
  }
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useRelayedSubagentMessages(
  threadId: string | null,
): ReadonlyArray<RelayedSubagentMessage> {
  return useSyncExternalStore(subscribe, () =>
    threadId === null ? EMPTY : readRelayedSubagentMessages(threadId),
  );
}
