import type { OrchestratorMcpDelegateTaskResult, RunId, ThreadId } from "@t3tools/contracts";

/** Long identifiers server internals need; MCP handlers strip them from agent-facing results. */
export type DelegateTaskDetails = OrchestratorMcpDelegateTaskResult & {
  readonly childThreadId: ThreadId;
  readonly childRunId: RunId | null;
};

export const compactDelegateTaskResult = (
  result: OrchestratorMcpDelegateTaskResult &
    Partial<Pick<DelegateTaskDetails, "childThreadId" | "childRunId">>,
): OrchestratorMcpDelegateTaskResult => {
  const compact = { ...result };
  delete compact.childThreadId;
  delete compact.childRunId;
  return compact;
};
