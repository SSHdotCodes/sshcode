import {
  isProviderNativeSubagentThread,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";

/**
 * A `delegate_task` child asks its parent agent, which asks the user only when
 * it needs to. The question must not become a reply field on the child thread.
 * Provider-native subagents ask on the parent session instead, and a plain fork
 * is a conversation the user still answers.
 */
export function delegatedChildQuestionIsForParent(
  thread: Pick<OrchestrationV2ThreadShell, "lineage" | "forkedFrom" | "creationSource">,
): boolean {
  return (
    thread.lineage.relationshipToParent === "subagent" &&
    thread.forkedFrom?.type === "node" &&
    !isProviderNativeSubagentThread(thread)
  );
}
