import type * as DateTime from "effect/DateTime";
import type { OrchestrationV2TurnItem, RunId, TurnItemId } from "@t3tools/contracts";

/** Input of the turn item that stands for a deferred run's workspace preparation. */
export const WORKSPACE_PREPARATION_INPUT = "Preparing workspace";

/**
 * The project setup notice a released preparation recorded for the run, told
 * to the agent at the start of the run's first turn.
 */
export function workspaceSetupNotice(
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  runId: RunId,
): string | undefined {
  const item = turnItems.find(
    (candidate) =>
      candidate.runId === runId &&
      candidate.type === "command_execution" &&
      candidate.input === WORKSPACE_PREPARATION_INPUT &&
      candidate.status === "completed",
  );
  return item?.type === "command_execution" && item.outputIndicatesFailure === true
    ? item.output
    : undefined;
}

export function workspacePreparationItem(
  userItem: OrchestrationV2TurnItem,
  id: TurnItemId,
  now: DateTime.Utc,
): OrchestrationV2TurnItem {
  return {
    id,
    threadId: userItem.threadId,
    runId: userItem.runId,
    nodeId: userItem.nodeId,
    providerThreadId: userItem.providerThreadId ?? null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: userItem.ordinal + 1,
    status: "running",
    title: WORKSPACE_PREPARATION_INPUT,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    type: "command_execution",
    input: WORKSPACE_PREPARATION_INPUT,
  };
}
