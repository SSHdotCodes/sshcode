import { isModelManagerThreadId } from "./modelManager.ts";

/**
 * Overview is a read-only chat that tells the user what is going on across
 * all their chats. Its threads are ordinary threads whose ids carry this
 * prefix, so the server and every client recognise them without stored state.
 */
export const OVERVIEW_THREAD_ID_PREFIX = "overview-";

export const OVERVIEW_THREAD_TITLE = "Overview";

export function isOverviewThreadId(threadId: string): boolean {
  return threadId.startsWith(OVERVIEW_THREAD_ID_PREFIX);
}

/** App-owned assistants have their own UI rather than ordinary chat entries. */
export function isHelperThreadId(threadId: string): boolean {
  return isOverviewThreadId(threadId) || isModelManagerThreadId(threadId);
}
