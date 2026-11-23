import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  connectionWorkStatus,
  type EnvironmentConnectionPhase,
} from "@t3tools/client-runtime/connection";
import { buildChatTabs } from "@t3tools/client-runtime/state/chat-tabs";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ChatTab, EnvironmentId } from "@t3tools/contracts";

export function buildHomeChatTabs(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  connectionPhases: ReadonlyMap<EnvironmentId, EnvironmentConnectionPhase>,
  catalog: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly tab: ChatTab }>,
) {
  return buildChatTabs(
    threads.filter(
      (thread) => thread.archivedAt === null && thread.lineage.relationshipToParent !== "subagent",
    ),
    {
      catalog,
      threadKey: (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      status: (thread) => {
        if (
          thread.hasPendingApprovals ||
          thread.hasPendingUserInput ||
          thread.pendingSubagentRequest
        )
          return "attention";
        return threadRuntimeIsActive(thread.runtime) &&
          connectionWorkStatus(connectionPhases.get(thread.environmentId)) === null
          ? "working"
          : null;
      },
    },
  );
}
