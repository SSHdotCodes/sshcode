import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  OrchestrationV2ThreadProjection,
  ThreadId,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import { latestExecutedRun } from "./orchestrationV2ThreadError.ts";
import { truncate } from "./String.ts";
import { resolveT3McpToolId } from "./t3McpToolPresentation.ts";
import { threadPullRequestKeyOf } from "./threadPullRequests.ts";

const BACKGROUND_TURN_ITEM_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "command_execution",
  "dynamic_tool",
  "subagent",
]);

/**
 * True terminal run statuses (includes `rolled_back`). Retained as the
 * canonical terminal set for this module; do not widen or reuse it as the
 * background-wait gate — that gate intentionally excludes `rolled_back`.
 */
const TERMINAL_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "cancelled",
  "completed",
  "failed",
  "interrupted",
  "rolled_back",
]);

/**
 * Run statuses that allow a pending-background roster to surface.
 * Includes `waiting`: a successful turn persists as waiting until checkpoint
 * capture flips it to completed, and waiting is only set from completed.
 * Excludes `rolled_back`: the provider-thread roster is not run-tied, so a
 * rolled-back latest run must fail the gate entirely (not only item filter).
 * Built explicitly rather than spreading or deleting from TERMINAL_RUN_STATUSES.
 */
const SETTLED_FOR_BACKGROUND_WAIT_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "cancelled",
  "completed",
  "failed",
  "interrupted",
  "waiting",
]);

// Keep TERMINAL_RUN_STATUSES referenced so the true-terminal set stays defined
// next to the background-wait subset (rolled_back is terminal, not wait-settled).
void TERMINAL_RUN_STATUSES;

export type PendingBackgroundWorkTask = OrchestrationV2PendingBackgroundTask;

/**
 * Whether a turn-item update can end background work that a settled run is
 * still waiting on: an item of a background type that is no longer active.
 * Streaming output on a running item, and every other item type, cannot.
 */
export function turnItemUpdateCanEndBackgroundWork(
  item: Pick<OrchestrationV2TurnItem, "type" | "status">,
): boolean {
  return BACKGROUND_TURN_ITEM_TYPES.has(item.type) && !isOrchestrationV2WorkActive(item.status);
}

/** A background subagent outlives its run and still calls tools. */
export function hasPendingBackgroundSubagent(
  tasks: ReadonlyArray<Pick<PendingBackgroundWorkTask, "kind">> | undefined,
): boolean {
  return tasks?.some((task) => task.kind === "subagent") ?? false;
}

type CompletionHoldingWork = Pick<PendingBackgroundWorkTask, "kind"> & {
  readonly wakesAgent?: true | undefined;
};

/** Delays settlement and completion alerts while the provider is expected to resume. */
export function backgroundWorkHoldsCompletion(
  tasks: ReadonlyArray<CompletionHoldingWork>,
): boolean {
  return tasks.some(backgroundWorkTaskHoldsCompletion);
}

export function backgroundWorkTaskHoldsCompletion(task: CompletionHoldingWork): boolean {
  return task.kind !== "command" || task.wakesAgent === true;
}

/**
 * A running agent is blocked only when its commands, tools and subagents in
 * progress are all thread waits. Edits, searches and compaction do not count:
 * the chat list reads pending items through an index that holds only those
 * three types, and every reader has to agree.
 */
export function deriveBlockedOnThreadWait(input: {
  readonly activeRun: Pick<OrchestrationV2Run, "id" | "status"> | null;
  readonly turnItems: ReadonlyArray<
    Pick<OrchestrationV2TurnItem, "type" | "status" | "runId"> & {
      readonly toolName?: string | null | undefined;
      readonly origin?: string | null | undefined;
      readonly input?: unknown;
    }
  >;
}): boolean {
  if (input.activeRun?.status !== "running") return false;
  let waiting = false;
  for (const item of input.turnItems) {
    if (
      item.runId !== input.activeRun.id ||
      (item.status !== "running" && item.status !== "waiting") ||
      (item.type === "subagent" && item.origin === "app_owned")
    )
      continue;
    switch (item.type) {
      case "dynamic_tool": {
        const tool = resolveT3McpToolId(item.toolName ?? "");
        if (
          tool !== "t3_thread_wait" &&
          !(
            tool === "delegate_task" &&
            item.input !== null &&
            typeof item.input === "object" &&
            Reflect.get(item.input, "mode") === "wait"
          )
        )
          return false;
        waiting = true;
        break;
      }
      case "command_execution":
      case "subagent":
        return false;
    }
  }
  return waiting;
}

type PendingBackgroundWorkRun = Pick<OrchestrationV2Run, "id" | "ordinal" | "status">;

type PendingBackgroundWorkPullRequest = Pick<
  ThreadPullRequestLink,
  "host" | "repository" | "number" | "url" | "source" | "watch"
>;

type PendingBackgroundWorkProviderThread = Pick<
  OrchestrationV2ProviderThread,
  "id" | "pendingBackgroundTasks"
> & {
  readonly waitingOnBackgroundWork?: true | undefined;
};

type PendingBackgroundWorkTurnItem = {
  readonly id: OrchestrationV2TurnItem["id"] | string;
  readonly type: OrchestrationV2TurnItem["type"];
  readonly status: OrchestrationV2TurnItem["status"];
  readonly title: string | null;
  readonly startedAt?: OrchestrationV2TurnItem["startedAt"];
  /** When present and the run is rolled_back, the item is abandoned, not pending. */
  readonly runId?: OrchestrationV2Run["id"] | string | null;
  readonly nativeItemRef?: {
    readonly nativeId: string | null;
  } | null;
  readonly input?: unknown;
  readonly monitor?: boolean | undefined;
  readonly wakesAgent?: true | undefined;
  readonly prompt?: string | undefined;
  readonly childThreadId?: ThreadId | null;
  readonly subagentId?: string;
  readonly origin?: string;
};

/**
 * A subagent projection row. For an app-owned subagent with its own chat, the
 * row's status, or its child activity once the task has published a result,
 * says whether that chat still runs; its card in the parent can say
 * `interrupted` because the parent run that started it was cut.
 */
export type PendingBackgroundWorkSubagent = Pick<
  OrchestrationV2Subagent,
  "id" | "origin" | "childThreadId" | "status" | "title" | "prompt"
> & {
  readonly runId?: OrchestrationV2Run["id"] | string | null;
  readonly startedAt?: OrchestrationV2Subagent["startedAt"];
  readonly childActivity?: { readonly status: OrchestrationV2Subagent["status"] } | undefined;
};

/**
 * An app-owned subagent runs in its own chat. The lead keeps working while it
 * does, so it is background work whichever run started it.
 */
function isAppOwnedChildItem(
  item: PendingBackgroundWorkTurnItem,
): item is PendingBackgroundWorkTurnItem & { readonly childThreadId: ThreadId } {
  return item.type === "subagent" && item.origin === "app_owned" && item.childThreadId != null;
}

export type PendingBackgroundChildRun = Pick<
  OrchestrationV2Run,
  "id" | "threadId" | "status" | "queueHeld" | "userMessageId" | "delegatedTaskId" | "requestedAt"
>;

/** The durable message identity of a t3_thread_send delegation, including legacy unbound runs. */
export function threadSendMessageId(taskId: string): string | undefined {
  const prefix = ["node:delegated-task:", "turn-item:delegated-task:"].find((prefix) =>
    taskId.startsWith(prefix),
  );
  if (prefix === undefined) return undefined;
  try {
    const commandId = decodeURIComponent(taskId.slice(prefix.length));
    return commandId.startsWith("command:mcp:") && commandId.includes(":thread-send:")
      ? commandId.replace(/^command:/, "message:")
      : undefined;
  } catch {
    return undefined;
  }
}

function isLatestRunSettledForBackgroundWait(
  latestRun: PendingBackgroundWorkRun | null | undefined,
): boolean {
  if (latestRun === undefined || latestRun === null) {
    return false;
  }
  return SETTLED_FOR_BACKGROUND_WAIT_RUN_STATUSES.has(latestRun.status);
}

function isPersistentDynamicToolInput(input: unknown): boolean {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  return Reflect.get(input, "persistent") === true;
}

function descriptionFromTurnItem(item: PendingBackgroundWorkTurnItem): string | undefined {
  // ACP's command cards can have a generic title such as "Ran command".
  if (item.type === "command_execution" && item.wakesAgent && typeof item.input === "string") {
    const label = truncate(item.input.trim().split("\n", 1)[0] ?? "", 60);
    if (label.length > 0) return label;
  }
  if (typeof item.title === "string" && item.title.trim().length > 0) {
    return item.title.trim();
  }
  if (item.type === "command_execution" && typeof item.input === "string") {
    const command = item.input.trim();
    return command.length > 0 ? command : undefined;
  }
  if (item.type === "dynamic_tool") {
    const toolName = Reflect.get(item, "toolName");
    if (typeof toolName === "string" && toolName.trim().length > 0) {
      return toolName.trim();
    }
  }
  if (item.type === "subagent" && typeof item.prompt === "string") {
    const prompt = item.prompt.trim();
    return prompt.length > 0 ? prompt : undefined;
  }
  return undefined;
}

function pendingTaskFromTurnItem(
  taskId: string,
  item: PendingBackgroundWorkTurnItem,
): PendingBackgroundWorkTask {
  const description = descriptionFromTurnItem(item);
  const named = { taskId, ...(description === undefined ? {} : { description }) };
  switch (item.type) {
    case "subagent":
      return {
        ...named,
        kind: "subagent",
        ...(item.childThreadId == null ? {} : { childThreadId: item.childThreadId }),
        ...(item.startedAt == null ? {} : { startedAt: DateTime.formatIso(item.startedAt) }),
      };
    case "command_execution":
      return item.monitor === true
        ? { ...named, kind: "monitor" }
        : {
            ...named,
            kind: "command",
            ...(item.wakesAgent === true ? { wakesAgent: true } : {}),
          };
    default:
      return { ...named, kind: "background_task" };
  }
}

function nativeTaskIdFromTurnItem(item: PendingBackgroundWorkTurnItem): string {
  const nativeId = item.nativeItemRef?.nativeId;
  if (typeof nativeId === "string" && nativeId.length > 0) {
    return nativeId;
  }
  return String(item.id);
}

/**
 * The turn items the pending-work list names, without its settled-run gate.
 * Stop ends exactly these, so the list and Stop cannot disagree.
 */
export function pendingBackgroundTurnItems<Item extends PendingBackgroundWorkTurnItem>(input: {
  readonly turnItems: ReadonlyArray<Item>;
  readonly runs?: ReadonlyArray<PendingBackgroundWorkRun>;
}): ReadonlyArray<Item> {
  const rolledBackRunIds = new Set(
    (input.runs ?? []).filter((run) => run.status === "rolled_back").map((run) => String(run.id)),
  );
  return input.turnItems.filter(
    (item) =>
      BACKGROUND_TURN_ITEM_TYPES.has(item.type) &&
      isOrchestrationV2WorkActive(item.status) &&
      !(item.type === "dynamic_tool" && isPersistentDynamicToolInput(item.input)) &&
      // Null/absent run id stays eligible; only known rolled_back runs drop.
      (item.runId === undefined ||
        item.runId === null ||
        !rolledBackRunIds.has(String(item.runId))),
  );
}

/**
 * Derive one normalized pending-background-work list for post-settlement UI.
 *
 * Sources:
 * - Provider-thread roster (Claude SDK background tasks)
 * - Active command_execution / dynamic_tool / subagent turn items
 * - Pull request watches, as monitors: a watch wakes the agent, so the thread
 *   stays working between wakes instead of returning to the inbox. Callers
 *   that pick a run to interrupt leave `pullRequests` out; Stop ends watches
 *   on its own.
 *
 * Gated on latest root run settlement. Dedupes by native task ID. Excludes
 * the roster while any interruptible foreground run remains active. Excludes
 * Grok persistent monitors (`dynamic_tool` input with `persistent: true`).
 * Excludes turn items whose run resolves to `rolled_back` (abandoned work);
 * items with a null or absent run id stay eligible (matches SQL shell path).
 * Subagent rows only decide whether an app-owned child chat still runs: its
 * card is listed, or named from the row when no card is loaded, once per child.
 */
function activeProviderThreadWaitingOnBackgroundWork(input: {
  readonly providerThreads: ReadonlyArray<PendingBackgroundWorkProviderThread>;
  readonly activeProviderThreadId?: string | null;
}): boolean {
  const providerThreads =
    input.activeProviderThreadId === undefined || input.activeProviderThreadId === null
      ? input.providerThreads
      : input.providerThreads.filter((thread) => thread.id === input.activeProviderThreadId);
  return providerThreads.some(
    (thread) =>
      thread.waitingOnBackgroundWork === true &&
      backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? []),
  );
}

export function derivePendingBackgroundWork(input: {
  readonly latestRun: PendingBackgroundWorkRun | null | undefined;
  readonly providerThreads: ReadonlyArray<PendingBackgroundWorkProviderThread>;
  readonly turnItems: ReadonlyArray<PendingBackgroundWorkTurnItem>;
  readonly activeProviderThreadId?: string | null;
  readonly hasActiveRun?: boolean;
  /**
   * Run rows used to exclude items owned by rolled_back runs. Optional for
   * callers that already filtered (SQL shell path); in-memory callers should
   * pass projection runs so policy cannot drift.
   */
  readonly runs?: ReadonlyArray<PendingBackgroundWorkRun>;
  readonly pullRequests?: ReadonlyArray<PendingBackgroundWorkPullRequest> | undefined;
  readonly childRuns?: ReadonlyArray<PendingBackgroundChildRun>;
  readonly subagents?: ReadonlyArray<PendingBackgroundWorkSubagent>;
}): ReadonlyArray<PendingBackgroundWorkTask> {
  const hasActiveRun =
    input.hasActiveRun ??
    input.runs?.some(
      (run) => run.status === "preparing" || run.status === "starting" || run.status === "running",
    ) ??
    false;
  if (hasActiveRun) {
    if (!activeProviderThreadWaitingOnBackgroundWork(input)) {
      return [];
    }
    const activeRunIds = new Set(
      (input.runs ?? [])
        .filter(
          (run) =>
            run.status === "preparing" || run.status === "starting" || run.status === "running",
        )
        .map((run) => String(run.id)),
    );
    return collectPendingBackgroundWork(
      input.runs === undefined
        ? { ...input, turnItems: input.turnItems.filter(isAppOwnedChildItem) }
        : input,
      activeRunIds,
    );
  }
  // A thread that never ran waits on nothing else, but a watch started on it still wakes it.
  if (input.latestRun == null) {
    return pullRequestWatchTasks(input.pullRequests);
  }
  if (!isLatestRunSettledForBackgroundWait(input.latestRun)) {
    return [];
  }

  return collectPendingBackgroundWork(input, new Set());
}

/** The executed run Stop targets for work still attached to a settled thread. */
export function backgroundWorkInterruptTarget(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "providerThreads" | "turnItems" | "subagents"
  >,
) {
  const latestRun = latestExecutedRun(projection.runs);
  if (latestRun === null) return undefined;
  const work = derivePendingBackgroundWork({
    latestRun,
    runs: projection.runs,
    providerThreads: projection.providerThreads,
    activeProviderThreadId: projection.thread.activeProviderThreadId,
    turnItems: projection.turnItems,
    subagents: projection.subagents,
  });
  return work.length > 0 ? latestRun : undefined;
}

/**
 * Background work that keeps running while the root agent works on a later
 * turn: the provider roster, background items earlier runs left running, and
 * pull request watches, plus every app-owned subagent whose chat still runs.
 * Active runs' other items are their foreground work (a command the agent
 * waits on, a native subagent it blocks on) and already show in the live work
 * log.
 */
export function deriveBackgroundWorkDuringRun(input: {
  readonly runs: ReadonlyArray<PendingBackgroundWorkRun>;
  readonly providerThreads: ReadonlyArray<PendingBackgroundWorkProviderThread>;
  readonly turnItems: ReadonlyArray<PendingBackgroundWorkTurnItem>;
  readonly activeProviderThreadId?: string | null;
  readonly pullRequests?: ReadonlyArray<PendingBackgroundWorkPullRequest> | undefined;
  readonly childRuns?: ReadonlyArray<PendingBackgroundChildRun>;
  readonly subagents?: ReadonlyArray<PendingBackgroundWorkSubagent>;
}): ReadonlyArray<PendingBackgroundWorkTask> {
  const activeRunIds = new Set(
    input.runs
      .filter(
        (run) =>
          run.status === "preparing" || run.status === "starting" || run.status === "running",
      )
      .map((run) => String(run.id)),
  );
  return collectPendingBackgroundWork(input, activeRunIds);
}

/** Compact counts for list membership, from the same bounded roster and pending items. */
export function longRunningWorkForShell(
  input: Parameters<typeof deriveBackgroundWorkDuringRun>[0],
) {
  const background = deriveBackgroundWorkDuringRun(input);
  // A subagent counts even when its parent is still in the foreground run.
  const all = collectPendingBackgroundWork(input, new Set());
  return {
    monitorCount: all.filter((task) => task.kind === "monitor").length,
    backgroundTaskCount: background.filter(
      (task) => task.kind !== "monitor" && task.kind !== "subagent",
    ).length,
    runningSubagentCount: all.filter((task) => task.kind === "subagent" && task.held === undefined)
      .length,
  };
}

function collectPendingBackgroundWork(
  input: {
    readonly providerThreads: ReadonlyArray<PendingBackgroundWorkProviderThread>;
    readonly turnItems: ReadonlyArray<PendingBackgroundWorkTurnItem>;
    readonly activeProviderThreadId?: string | null;
    readonly runs?: ReadonlyArray<PendingBackgroundWorkRun>;
    readonly pullRequests?: ReadonlyArray<PendingBackgroundWorkPullRequest> | undefined;
    readonly childRuns?: ReadonlyArray<PendingBackgroundChildRun>;
    readonly subagents?: ReadonlyArray<PendingBackgroundWorkSubagent>;
  },
  excludedRunIds: ReadonlySet<string>,
): ReadonlyArray<PendingBackgroundWorkTask> {
  const byTaskId = new Map<string, PendingBackgroundWorkTask>();

  const providerThreads =
    input.activeProviderThreadId === undefined || input.activeProviderThreadId === null
      ? input.providerThreads
      : input.providerThreads.filter((thread) => thread.id === input.activeProviderThreadId);

  for (const providerThread of providerThreads) {
    for (const task of providerThread.pendingBackgroundTasks ?? []) {
      if (task.taskId.length === 0 || byTaskId.has(task.taskId)) {
        continue;
      }
      const { description: rawDescription, ...named } = task;
      const description = rawDescription?.trim();
      byTaskId.set(task.taskId, {
        ...named,
        ...(description === undefined || description.length === 0 ? {} : { description }),
      });
    }
  }

  // A resumed child has both its original card and a follow-up task card.
  // Count the child once, preferring the later task for actions on that work.
  const subagentTaskByChild = new Map<string, string>();
  for (const task of byTaskId.values()) {
    if (task.kind === "subagent" && task.childThreadId !== undefined)
      subagentTaskByChild.set(task.childThreadId, task.taskId);
  }
  const heldByTask = new Map<string, PendingBackgroundChildRun>();
  const heldByMessage = new Map<string, PendingBackgroundChildRun>();
  for (const run of input.childRuns ?? []) {
    if (run.status !== "queued" || run.queueHeld !== true) continue;
    if (run.delegatedTaskId !== undefined) heldByTask.set(run.delegatedTaskId, run);
    heldByMessage.set(run.userMessageId, run);
  }
  const rolledBackRunIds = new Set(
    (input.runs ?? []).filter((run) => run.status === "rolled_back").map((run) => String(run.id)),
  );
  // App-owned child chats that still run, by the subagent rows. A card the
  // parent's cut run marked interrupted still names such a child.
  const liveChildren = new Map<ThreadId, PendingBackgroundWorkSubagent>();
  for (const subagent of input.subagents ?? []) {
    if (
      subagent.origin === "app_owned" &&
      subagent.childThreadId !== null &&
      isOrchestrationV2WorkActive(subagent.childActivity?.status ?? subagent.status) &&
      !(subagent.runId != null && rolledBackRunIds.has(String(subagent.runId)))
    )
      liveChildren.set(subagent.childThreadId, subagent);
  }
  const pendingItems = new Set<PendingBackgroundWorkTurnItem>(pendingBackgroundTurnItems(input));
  const items = input.turnItems.filter(
    (item) =>
      pendingItems.has(item) ||
      (isAppOwnedChildItem(item) &&
        liveChildren.has(item.childThreadId) &&
        !(item.runId != null && rolledBackRunIds.has(String(item.runId)))),
  );
  for (const item of items) {
    if (
      item.runId != null &&
      excludedRunIds.has(String(item.runId)) &&
      !isAppOwnedChildItem(item)
    ) {
      continue;
    }
    const taskId = nativeTaskIdFromTurnItem(item);
    if (byTaskId.has(taskId)) {
      continue;
    }

    const task = pendingTaskFromTurnItem(taskId, item);
    if (task.kind === "subagent" && task.childThreadId !== undefined) {
      const previous = subagentTaskByChild.get(task.childThreadId);
      if (previous !== undefined) byTaskId.delete(previous);
      subagentTaskByChild.set(task.childThreadId, taskId);
    }
    const messageId = threadSendMessageId(item.id);
    const heldRun =
      (item.subagentId === undefined ? undefined : heldByTask.get(item.subagentId)) ??
      (messageId === undefined ? undefined : heldByMessage.get(messageId));
    byTaskId.set(
      taskId,
      task.kind === "subagent" && heldRun !== undefined && heldRun.threadId === task.childThreadId
        ? { ...task, held: { runId: heldRun.id, since: DateTime.formatIso(heldRun.requestedAt) } }
        : task,
    );
  }

  // A live child whose card is not loaded (the shell reads only pending cards)
  // is named from its row. The row id is the task's node id.
  for (const [childThreadId, subagent] of liveChildren) {
    if (subagentTaskByChild.has(childThreadId)) continue;
    const taskId = String(subagent.id);
    const description = (subagent.title ?? "").trim() || subagent.prompt.trim();
    const heldRun = heldByTask.get(taskId);
    byTaskId.set(taskId, {
      taskId,
      kind: "subagent",
      ...(description.length === 0 ? {} : { description }),
      childThreadId,
      ...(subagent.startedAt == null ? {} : { startedAt: DateTime.formatIso(subagent.startedAt) }),
      ...(heldRun !== undefined && heldRun.threadId === childThreadId
        ? { held: { runId: heldRun.id, since: DateTime.formatIso(heldRun.requestedAt) } }
        : {}),
    });
  }

  for (const task of pullRequestWatchTasks(input.pullRequests)) byTaskId.set(task.taskId, task);

  return Array.from(byTaskId.values());
}

function pullRequestWatchTasks(
  pullRequests: ReadonlyArray<PendingBackgroundWorkPullRequest> | undefined,
): Array<PendingBackgroundWorkTask> {
  return (pullRequests ?? []).flatMap((link) =>
    link.watch === undefined || link.source === "stack-dismissed"
      ? []
      : [
          {
            taskId: `pull-request-watch:${threadPullRequestKeyOf(link)}`,
            description: `Watching pull request #${link.number}`,
            kind: "monitor" as const,
          },
        ],
  );
}
