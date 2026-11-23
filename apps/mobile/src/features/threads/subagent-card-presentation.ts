import { isActiveSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import type {
  OrchestrationV2Notification,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItemStatus,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";

export function subagentCardDetail(detail: string | null): string | null {
  if (!detail || /^Child task ended with status\b/i.test(detail)) return null;
  return (
    detail
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/`/g, "")
      .replace(/^[ \t]*[-*][ \t]+/gm, "")
      .replace(/\s+/g, " ")
      .trim() || null
  );
}

/** A group's wall time spans its first launch to its last completion. */
export function subagentCardElapsed(
  agents: ReadonlyArray<Pick<OrchestrationV2Subagent, "status" | "startedAt" | "completedAt">>,
  nowMs: number,
): string | null {
  const starts = agents.flatMap((agent) =>
    agent.startedAt ? [DateTime.toEpochMillis(agent.startedAt)] : [],
  );
  if (starts.length === 0) return null;
  const live = agents.some((agent) => isActiveSubagentStatus(agent.status));
  // Settled agents without a completion timestamp must not keep counting their age.
  if (!live && agents.some((agent) => agent.completedAt === null)) return null;
  const ends = agents.flatMap((agent) =>
    agent.completedAt ? [DateTime.toEpochMillis(agent.completedAt)] : [],
  );
  const duration = (live ? nowMs : Math.max(...ends)) - Math.min(...starts);
  return duration > 0 ? formatDuration(duration) : null;
}

/** Notifications report a past outcome, even if the subagent has since resumed. */
export function subagentNotificationPresentation(outcome: OrchestrationV2Notification["outcome"]): {
  readonly status: OrchestrationV2TurnItemStatus | null;
  readonly statusLabel: string;
} {
  switch (outcome) {
    case "completed":
      return { status: "completed", statusLabel: "Finished" };
    case "failed":
      return { status: "failed", statusLabel: "Failed" };
    case "cancelled":
      return { status: "cancelled", statusLabel: "Stopped" };
    case "updated":
      return { status: null, statusLabel: "Updated" };
    case "unknown":
      return { status: null, statusLabel: "Finished" };
  }
}
