import type { OrchestratorMcpDelegateTaskResult, RunId, ThreadId } from "@t3tools/contracts";

/** Long identifiers server internals need; MCP handlers strip them from agent-facing results. */
export type DelegateTaskDetails = OrchestratorMcpDelegateTaskResult & {
  readonly childThreadId: ThreadId;
  readonly childRunId: RunId | null;
};

const MAX_SUMMARY_BYTES = 16384;
const encoder = new TextEncoder();

export const compactDelegateTaskResult = (
  result: OrchestratorMcpDelegateTaskResult &
    Partial<Pick<DelegateTaskDetails, "childThreadId" | "childRunId">>,
  summaryOffset = 0,
): OrchestratorMcpDelegateTaskResult => {
  const { childThreadId: _threadId, childRunId: _runId, ...compact } = result;
  if (compact.summary === undefined) return compact;
  const summary = compact.summary.slice(summaryOffset);
  if (Buffer.byteLength(summary) <= MAX_SUMMARY_BYTES) return { ...compact, summary };
  // encodeInto stops at a whole Unicode code point and reports the UTF-16 offset.
  const { read } = encoder.encodeInto(summary, new Uint8Array(MAX_SUMMARY_BYTES));
  return {
    ...compact,
    summary: summary.slice(0, read),
    nextSummaryOffset: summaryOffset + read,
  };
};
