import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";

type Visibility = OrchestrationV2ProjectedTurnItem["visibility"];

export interface SubagentMemberRef<Id extends string = string> {
  readonly visibility: Visibility;
  readonly threadId: Id;
}

/**
 * The thread whose live subagent roster may update cards in this group.
 * Inherited items keep the source thread's id, so a fork must not subscribe to
 * that thread: its live agents would show as working in a chat that has none.
 * A group with no local card, or local cards from two threads, stays on the
 * stored snapshot.
 */
export function liveSubagentThreadId<Id extends string>(
  members: ReadonlyArray<SubagentMemberRef<Id>>,
): Id | null {
  let threadId: Id | null = null;
  for (const member of members) {
    if (member.visibility !== "local") continue;
    if (threadId === null) {
      threadId = member.threadId;
      continue;
    }
    if (threadId !== member.threadId) return null;
  }
  return threadId;
}

export function shouldOverlaySubagentStatus(
  member: SubagentMemberRef,
  liveThreadId: string | null,
): boolean {
  return liveThreadId !== null && member.visibility === "local" && member.threadId === liveThreadId;
}
