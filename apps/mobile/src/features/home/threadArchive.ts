import {
  threadRuntimeCanArchive,
  type ThreadRuntimeSummary,
} from "@t3tools/client-runtime/state/models";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

/**
 * Archiving may discard queued work, but it must not detach a provider while
 * that provider is still executing a turn.
 */
export function threadCanArchive(runtime: ThreadRuntimeSummary | null | undefined): boolean {
  return threadRuntimeCanArchive(runtime);
}

/**
 * Why the server would refuse to settle this thread, for the cases it always
 * refuses: a turn that is executing, or an approval waiting on the user.
 * Checked before the row animates away so a swipe on live work explains
 * itself instead of snapping back. Queued messages and questions are left to
 * the server, which knows whether they block.
 */
export function threadSettleBlockReason(
  thread: Pick<EnvironmentThreadShell, "hasPendingApprovals" | "runtime">,
): string | null {
  if (thread.hasPendingApprovals) {
    return "This chat is waiting on an approval. Answer it, then settle the chat.";
  }
  const status = thread.runtime?.status;
  if (status === "preparing" || status === "starting" || status === "running") {
    return "This chat is still working. Stop it or let it finish, then settle it.";
  }
  return null;
}
