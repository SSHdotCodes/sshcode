/**
 * How many of the app's own monitors each chat has running. They run outside
 * the transcript, so the monitor service keeps this current and a thread shell
 * reads it without asking the service: a chat that only waits on its monitors
 * still counts as long-running work.
 */
import { announceBoxChange } from "../sessionBoxes/boxNamerCache.ts";

let counts: ReadonlyMap<string, number> = new Map();

export const appMonitorCount = (threadId: string): number => counts.get(threadId) ?? 0;

/** The chats with a monitor running now. */
export const appMonitorThreadIds = (): ReadonlyArray<string> => [...counts.keys()];

/** Replaces the counts: one thread id per running monitor. Chats whose count moved are re-sent. */
export function publishAppMonitors(threadIds: ReadonlyArray<string>): void {
  const next = new Map<string, number>();
  for (const id of threadIds) next.set(id, (next.get(id) ?? 0) + 1);
  const previous = counts;
  counts = next;
  for (const id of new Set([...previous.keys(), ...next.keys()])) {
    if (previous.get(id) !== next.get(id)) announceBoxChange(id);
  }
}
