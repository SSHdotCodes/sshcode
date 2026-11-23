import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import { resolveSidebarThreadStatus } from "./components/Sidebar.logic";

type KeepAwakeThread = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "deletedAt"
  | "archivedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "runtime"
>;

/**
 * The agent work in flight on one machine: a turn that is running, and chats that wait on
 * background work. Chats that wait on the user do not count; nothing happens until they answer.
 */
export function agentWorkOnMachine(
  threads: ReadonlyArray<KeepAwakeThread>,
  environmentId: string | null,
): { working: boolean; waiting: boolean } {
  let working = false;
  let waiting = false;
  if (environmentId === null) return { working, waiting };
  for (const thread of threads) {
    if (thread.environmentId !== environmentId) continue;
    if (thread.deletedAt !== null || thread.archivedAt !== null) continue;
    const status = resolveSidebarThreadStatus(thread);
    if (status === "working") working = true;
    else if (status === "waiting") waiting = true;
    if (working && waiting) break;
  }
  return { working, waiting };
}
