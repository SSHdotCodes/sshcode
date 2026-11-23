import * as DateTime from "effect/DateTime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { Persistence } from "@t3tools/client-runtime/platform";
import { failureNeedsYou } from "@t3tools/client-runtime/state/thread-inbox";

/**
 * Completed-but-not-yet-seen, mirroring the web sidebar's
 * hasUnseenCompletion. The visited watermark is server state
 * (thread.lastVisitedAt), so the marker agrees across web and mobile.
 * Never-visited threads count as read — a fresh environment must not light
 * up its whole history — and pre-tracking servers (field absent) never
 * report unread.
 */
export function threadHasUnseenCompletion(
  thread: Pick<EnvironmentThreadShell, "latestRun" | "lastVisitedAt">,
): boolean {
  const completedAt = thread.latestRun?.completedAt;
  if (!completedAt) return false;
  const status = thread.latestRun?.status;
  if (status === "interrupted" || status === "cancelled") return false;
  const completedAtMs = Date.parse(completedAt);
  if (Number.isNaN(completedAtMs)) return false;
  if (!thread.lastVisitedAt) return false;
  const lastVisitedAtMs = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAtMs)) return true;
  return completedAtMs > lastVisitedAtMs;
}

/** Requests and plans always; a failure only until the chat has been opened. */
export function threadNeedsYou(thread: EnvironmentThreadShell, now = Date.now()): boolean {
  return (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.pendingSubagentRequest === "approval" ||
    thread.pendingSubagentRequest === "user_input" ||
    thread.hasActionableProposedPlan ||
    failureNeedsYou(thread, now)
  );
}

export function threadHasUnreadOutput(thread: EnvironmentThreadShell): boolean {
  if (!thread.lastVisitedAt) return false;
  const message = thread.source.latestVisibleMessage;
  return (
    (message?.role === "assistant" &&
      DateTime.toEpochMillis(message.updatedAt) > Date.parse(thread.lastVisitedAt)) ||
    threadHasUnseenCompletion(thread)
  );
}

export function homeMachineSummaries(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  previews?: ReadonlyMap<string, Persistence.ShellPreviewCounts | null>,
) {
  const machines = new Map<string, { needsYou: number; unread: boolean }>();
  for (const thread of threads) {
    if (previews?.has(thread.environmentId)) continue;
    if (thread.archivedAt !== null || thread.lineage.relationshipToParent === "subagent") continue;
    const machine = machines.get(thread.environmentId) ?? { needsYou: 0, unread: false };
    machine.needsYou += threadNeedsYou(thread) ? 1 : 0;
    machine.unread ||= threadHasUnreadOutput(thread);
    machines.set(thread.environmentId, machine);
  }
  for (const [id, counts] of previews ?? []) {
    if (counts === null || counts.visibleChats > 0)
      machines.set(id, { needsYou: counts?.needsYou ?? 0, unread: counts?.unread ?? false });
  }
  return machines;
}
