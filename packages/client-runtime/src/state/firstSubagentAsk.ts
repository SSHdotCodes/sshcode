import type {
  EnvironmentId,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { isActiveSubagentStatus } from "./subagentRuntime.ts";

/**
 * Where "Keep solo" stops a chat's first subagent, or null when its row shows
 * no ask. The server keeps the ask open while that subagent runs unanswered
 * with the switch on, for at most a minute (silence counts as "Fine"); the
 * row's own status hides it as soon as the subagent stops. A subagent that has not started yet has no run to stop, so it waits.
 */
export function firstSubagentAskTarget(
  shell: Pick<OrchestrationV2ThreadShell, "firstSubagentAsk"> | null | undefined,
  agent: Pick<
    OrchestrationV2Subagent,
    "id" | "origin" | "childThreadId" | "startedAt" | "status" | "remote"
  >,
  environmentId: EnvironmentId,
): { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null {
  if (
    shell?.firstSubagentAsk !== agent.id ||
    agent.origin !== "app_owned" ||
    agent.childThreadId === null ||
    agent.startedAt === null ||
    !isActiveSubagentStatus(agent.status)
  )
    return null;
  return {
    environmentId: agent.remote?.environmentId ?? environmentId,
    threadId: agent.childThreadId,
  };
}
