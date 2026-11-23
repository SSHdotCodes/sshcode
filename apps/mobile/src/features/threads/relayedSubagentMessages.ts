import {
  decodeRelayedSubagentMessages,
  recentRelayedSubagentMessages,
  relayedSubagentMessagesStorageKey,
  type RelayedSubagentMessage,
} from "@t3tools/client-runtime/state/thread-execution";
import Storage from "expo-sqlite/kv-store";
import { useEffect, useSyncExternalStore } from "react";

/**
 * What this phone sent to provider subagents through their parents. The
 * provider owns a subagent's conversation, so the message lives in the parent
 * chat; the subagent chat shows this phone's copy so you can see it went.
 */
const EMPTY: ReadonlyArray<RelayedSubagentMessage> = [];
const listeners = new Set<() => void>();
const cache = new Map<string, ReadonlyArray<RelayedSubagentMessage>>();
const loads = new Map<string, Promise<void>>();

function notify() {
  for (const listener of listeners) listener();
}

function load(threadId: string): Promise<void> {
  const existing = loads.get(threadId);
  if (existing !== undefined) return existing;
  const loading = Storage.getItem(relayedSubagentMessagesStorageKey(threadId))
    .catch(() => null)
    .then((raw) => {
      // A message sent while this read ran is already newer than storage.
      const stored = decodeRelayedSubagentMessages(raw);
      const merged = [...stored, ...(cache.get(threadId) ?? [])];
      cache.set(threadId, recentRelayedSubagentMessages(merged, Date.now()));
      notify();
    });
  loads.set(threadId, loading);
  return loading;
}

export function rememberRelayedSubagentMessage(threadId: string, text: string): void {
  const now = Date.now();
  const sent = { text, sentAt: now };
  cache.set(threadId, recentRelayedSubagentMessages([...(cache.get(threadId) ?? []), sent], now));
  notify();
  void load(threadId)
    .then(() =>
      Storage.setItem(
        relayedSubagentMessagesStorageKey(threadId),
        JSON.stringify(cache.get(threadId) ?? [sent]),
      ),
    )
    .catch(() => undefined);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useRelayedSubagentMessages(
  threadId: string | null,
): ReadonlyArray<RelayedSubagentMessage> {
  useEffect(() => {
    if (threadId !== null) void load(threadId);
  }, [threadId]);
  return useSyncExternalStore(subscribe, () =>
    threadId === null ? EMPTY : (cache.get(threadId) ?? EMPTY),
  );
}
