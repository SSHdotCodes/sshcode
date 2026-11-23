import {
  type MessageId,
  OrchestrationV2BackgroundToolCallError,
  type OrchestrationV2BackgroundToolCallInput,
  type OrchestrationV2BackgroundToolCallResult,
  type OrchestrationV2TurnItem,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "./runtime.ts";

/** A steer the agent hasn't read yet and the running calls it is waiting on. */
export interface SteerWait {
  readonly messageId: MessageId;
  readonly toolCount: number;
  /** A command's first line, a tool title, or a count of parallel calls. */
  readonly label: string;
  readonly isCommand: boolean;
  readonly startedAtMs: number;
  /** Claude shell commands and subagents that can be moved to the background. */
  readonly sendNowToolItemIds: ReadonlyArray<TurnItemId>;
}

/** Items the agent produces; one after the steer means the agent has read it. */
const AGENT_ITEM_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "assistant_message",
  "reasoning",
  "command_execution",
  "dynamic_tool",
  "file_change",
  "file_search",
  "web_search",
  "subagent",
  "todo_list",
  "proposed_plan",
  "approval_request",
  "user_input_request",
]);

const WAITED_ON_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "command_execution",
  "dynamic_tool",
  "file_search",
  "web_search",
  "subagent",
]);

const PARALLEL_LABELS: Partial<Record<OrchestrationV2TurnItem["type"], string>> = {
  command_execution: "commands",
  subagent: "subagents",
  file_search: "file searches",
  web_search: "web searches",
};

const MAX_LABEL_LENGTH = 60;
const isBackgroundToolCallError = Schema.is(OrchestrationV2BackgroundToolCallError);

function commandLabel(command: string): string {
  const firstLine = command.trim().split("\n", 1)[0]!.replace(/\s+/g, " ");
  return firstLine.length > MAX_LABEL_LENGTH
    ? `${firstLine.slice(0, MAX_LABEL_LENGTH - 1).trimEnd()}…`
    : firstLine;
}

function waitedOnLabel(item: OrchestrationV2TurnItem): string {
  if (item.type === "command_execution") return commandLabel(item.input);
  return item.title?.trim() || (item.type === "subagent" ? "a subagent" : "the current step");
}

/**
 * The latest steer in `turnItems` when the agent has produced nothing since it
 * and calls that started before it are still running. Agents read a steer
 * between tool calls. An app-owned subagent runs in the background, so its
 * launch has already returned to the agent.
 */
export function deriveSteerWait(
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): SteerWait | null {
  let steer: Extract<OrchestrationV2TurnItem, { type: "user_message" }> | null = null;
  for (const item of turnItems) {
    if (
      item.type === "user_message" &&
      (item.inputIntent === "steer" || item.inputIntent === "promoted_queued_to_steer") &&
      (steer === null || item.ordinal > steer.ordinal)
    ) {
      steer = item;
    }
  }
  if (steer === null || steer.runId === null) return null;
  const waitedOn: OrchestrationV2TurnItem[] = [];
  const sendNowToolItemIds: TurnItemId[] = [];
  let startedAtMs: number | null = null;
  for (const item of turnItems) {
    if (item.runId !== steer.runId) continue;
    if (item.ordinal > steer.ordinal) {
      if (AGENT_ITEM_TYPES.has(item.type)) return null;
      continue;
    }
    if (
      item.status === "running" &&
      item.parentItemId === null &&
      WAITED_ON_TYPES.has(item.type) &&
      !(item.type === "subagent" && item.origin === "app_owned")
    ) {
      waitedOn.push(item);
      if (item.startedAt !== null) {
        const start = DateTime.toEpochMillis(item.startedAt);
        startedAtMs = startedAtMs === null ? start : Math.min(startedAtMs, start);
      }
      if (
        item.nativeItemRef?.driver === "claudeAgent" &&
        (item.nativeItemRef.nativeId?.length ?? 0) > 0 &&
        (item.type === "command_execution" || item.type === "subagent")
      ) {
        sendNowToolItemIds.push(item.id);
      }
    }
  }
  const first = waitedOn[0];
  if (first === undefined || startedAtMs === null) return null;
  const toolCount = waitedOn.length;
  const noun = waitedOn.every((item) => item.type === first.type)
    ? (PARALLEL_LABELS[first.type] ?? "tool calls")
    : "tool calls";
  return {
    messageId: steer.messageId,
    toolCount,
    label: toolCount === 1 ? waitedOnLabel(first) : `${toolCount} ${noun}`,
    isCommand: toolCount === 1 && first.type === "command_execution",
    startedAtMs,
    sendNowToolItemIds,
  };
}

/** Value equality so streaming tool updates don't churn callers' context/props. */
export function sameSteerWait(a: SteerWait | null, b: SteerWait | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (
    a.messageId !== b.messageId ||
    a.toolCount !== b.toolCount ||
    a.label !== b.label ||
    a.isCommand !== b.isCommand ||
    a.startedAtMs !== b.startedAtMs ||
    a.sendNowToolItemIds.length !== b.sendNowToolItemIds.length
  ) {
    return false;
  }
  for (let i = 0; i < a.sendNowToolItemIds.length; i++) {
    if (a.sendNowToolItemIds[i] !== b.sendNowToolItemIds[i]) return false;
  }
  return true;
}

/** Sends the batch in one request and finishes it with single-ID calls on older servers. */
export async function sendSteerNow(
  threadId: ThreadId,
  [turnItemId, ...additionalTurnItemIds]: ReadonlyArray<TurnItemId>,
  backgroundToolCall: (
    input: OrchestrationV2BackgroundToolCallInput,
  ) => Promise<AtomCommandResult<OrchestrationV2BackgroundToolCallResult, unknown>>,
): Promise<unknown> {
  if (turnItemId === undefined) return;
  const first = await backgroundToolCall({ threadId, turnItemId, additionalTurnItemIds });
  if (isAtomCommandInterrupted(first)) return;

  let moved = first._tag === "Success";
  let failure: unknown;
  if (first._tag === "Success") {
    if (first.value !== undefined) return;
  } else {
    const error = squashAtomCommandFailure(first);
    if (!isBackgroundToolCallError(error) || error.handledBatch) {
      return error;
    }
    if (error.reason !== "not-running") failure = error;
  }

  // An older server ignores the additional IDs and handles just the first call.
  for (const id of additionalTurnItemIds) {
    const result = await backgroundToolCall({ threadId, turnItemId: id });
    if (result._tag === "Success") {
      moved = true;
    } else {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      if (isBackgroundToolCallError(error) && error.reason === "not-running") {
        continue;
      }
      failure ??= error;
    }
  }
  return moved ? undefined : failure;
}

/** "0:42", "3:21", "1:02:05". */
export function formatSteerWaitElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}
