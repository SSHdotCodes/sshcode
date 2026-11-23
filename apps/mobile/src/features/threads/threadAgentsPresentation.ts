import {
  connectionWorkLabel,
  connectionWorkStatus,
  type EnvironmentConnectionPhase,
} from "@t3tools/client-runtime/connection";
import {
  formatSubagentDisplayTitle,
  subagentDetailPreview,
} from "@t3tools/client-runtime/state/subagent-display";
import { isActiveSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, OrchestrationV2Subagent, ThreadId } from "@t3tools/contracts";

const PROMPT_TITLE_LIMIT = 80;

export type SubagentRowTone = "working" | "completed" | "failed" | "stopped";

export interface SubagentRowPresentation {
  readonly title: string;
  /** Live agents lead with progress; settled ones lead with what came out. */
  readonly detail: string | null;
  readonly statusLabel: string;
  readonly tone: SubagentRowTone;
  readonly live: boolean;
  /** Provider-native tasks have no thread of their own to open. */
  readonly canOpenThread: boolean;
}

function rowTitle(subagent: Pick<OrchestrationV2Subagent, "title" | "prompt">): string {
  const title = subagent.title?.trim();
  if (title) return formatSubagentDisplayTitle(title);
  const prompt = subagent.prompt.trim();
  if (prompt.length === 0) return "Subagent";
  return prompt.length > PROMPT_TITLE_LIMIT
    ? `${prompt.slice(0, PROMPT_TITLE_LIMIT - 3)}...`
    : prompt;
}

function rowTone(status: OrchestrationV2Subagent["status"]): SubagentRowTone {
  if (isActiveSubagentStatus(status)) return "working";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "stopped";
}

function rowStatusLabel(status: OrchestrationV2Subagent["status"]): string {
  switch (status) {
    case "pending":
      return "Queued";
    case "running":
      return "Running";
    case "waiting":
      return "Waiting";
    case "idle":
      return "Idle · resumable";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
    case "interrupted":
      return "Stopped";
  }
}

export function resolveSubagentRowPresentation(
  subagent: Pick<
    OrchestrationV2Subagent,
    "title" | "prompt" | "status" | "progress" | "result" | "childThreadId"
  >,
  phase?: EnvironmentConnectionPhase,
): SubagentRowPresentation {
  const live = isActiveSubagentStatus(subagent.status);
  const connection = live ? connectionWorkStatus(phase) : null;
  if (connection !== null)
    return {
      title: rowTitle(subagent),
      detail: null,
      statusLabel: connectionWorkLabel(connection),
      tone: "stopped",
      live: false,
      canOpenThread: subagent.childThreadId !== null,
    };
  return {
    title: rowTitle(subagent),
    detail: subagentDetailPreview(subagent),
    statusLabel: rowStatusLabel(subagent.status),
    tone: rowTone(subagent.status),
    live,
    canOpenThread: subagent.childThreadId !== null,
  };
}

/**
 * Where a Stop tap on this row goes, or null when the phone can't stop it.
 * App-owned tasks stop by interrupting their child thread, as on the Mac.
 * Provider-native tasks need native task state the phone roster doesn't
 * carry, so their stop stays on the Mac.
 */
export function subagentStopTarget(
  subagent: Pick<
    OrchestrationV2Subagent,
    "origin" | "childThreadId" | "startedAt" | "status" | "remote"
  >,
  environmentId: EnvironmentId,
): { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null {
  if (
    subagent.origin !== "app_owned" ||
    subagent.childThreadId === null ||
    subagent.startedAt === null ||
    !isActiveSubagentStatus(subagent.status)
  ) {
    return null;
  }
  return {
    environmentId: subagent.remote?.environmentId ?? environmentId,
    threadId: subagent.childThreadId,
  };
}
