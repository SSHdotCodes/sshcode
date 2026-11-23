import { applyThreadPullRequestLinkUpdate } from "@t3tools/shared/threadPullRequests";
import { isQueuedProviderThreadPlaceholder } from "@t3tools/contracts";
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import {
  restoreSubagentBodies,
  restoreTurnItemBodies,
  type DedupedBodySource,
} from "@t3tools/shared/orchestrationV2DedupedBodies";
import {
  createOrchestrationV2TurnItemVisibility,
  isOrchestrationV2TurnItemVisible,
} from "@t3tools/shared/orchestrationV2Timeline";

export type ApplyOrchestrationV2ProjectionEventOptions = {
  readonly partialTimeline?: boolean;
  readonly latestLocalTurnOrdinal?: number | null;
};

type VisibleTurnItems = OrchestrationV2ThreadProjection["visibleTurnItems"];

interface VisibleTurnItemsRevision {
  readonly revision: object;
  readonly previousRevision: object | null;
  readonly originRevision: object;
  readonly index: number | null;
}

const visibleTurnItemsRevisions = new WeakMap<VisibleTurnItems, VisibleTurnItemsRevision>();
const visibleTurnItemIndices = new WeakMap<VisibleTurnItems, ReadonlyMap<unknown, number>>();
const entityIndices = new WeakMap<object, ReadonlyMap<unknown, number>>();

function entityIndex<T extends { readonly id: unknown }>(items: ReadonlyArray<T>, id: unknown) {
  let indices = entityIndices.get(items);
  if (!indices) {
    const next = new Map<unknown, number>();
    items.forEach((item, index) => {
      if (!next.has(item.id)) next.set(item.id, index);
    });
    entityIndices.set(items, (indices = next));
  }
  return indices.get(id) ?? -1;
}

function visibleTurnItemIndex(rows: VisibleTurnItems, id: unknown) {
  let indices = visibleTurnItemIndices.get(rows);
  if (!indices) {
    const next = new Map<unknown, number>();
    rows.forEach((row, index) => {
      if (!next.has(row.sourceItemId)) next.set(row.sourceItemId, index);
    });
    visibleTurnItemIndices.set(rows, (indices = next));
  }
  return indices.get(id) ?? -1;
}

/** Local change metadata, without retaining previous snapshots or changing the wire shape. */
export function visibleTurnItemsRevision(rows: VisibleTurnItems): VisibleTurnItemsRevision {
  let revision = visibleTurnItemsRevisions.get(rows);
  if (!revision) {
    const token = {};
    revision = { revision: token, originRevision: token, previousRevision: null, index: null };
    visibleTurnItemsRevisions.set(rows, revision);
  }
  return revision;
}

/** Consecutive chunks of one row may be coalesced before a client renders. */
export function isSingleRowReplacement(
  previous: VisibleTurnItemsRevision,
  next: VisibleTurnItemsRevision,
) {
  return (
    next.index !== null &&
    (next.previousRevision === previous.revision ||
      next.originRevision === previous.revision ||
      (next.index === previous.index && next.originRevision === previous.originRevision))
  );
}

/** Replacing a row in place preserves order and permits incremental client presentation. */
export function replaceVisibleTurnItem(
  rows: VisibleTurnItems,
  index: number,
  row: VisibleTurnItems[number],
): VisibleTurnItems {
  const updated = rows.slice();
  updated[index] = row;
  const previous = visibleTurnItemsRevision(rows);
  visibleTurnItemsRevisions.set(updated, {
    revision: {},
    previousRevision: previous.revision,
    originRevision: previous.index === index ? previous.originRevision : previous.revision,
    index,
  });
  const indices = visibleTurnItemIndices.get(rows);
  if (indices && rows[index]?.sourceItemId === row.sourceItemId)
    visibleTurnItemIndices.set(updated, indices);
  return updated;
}

function upsertEntity<T extends { readonly id: unknown }>(
  items: ReadonlyArray<T>,
  item: T,
): ReadonlyArray<T> {
  const index = entityIndex(items, item.id);
  if (index === -1) return [...items, item];
  const next = [...items];
  next[index] = item;
  entityIndices.set(next, entityIndices.get(items)!);
  return next;
}

// A deduped item repeats a record the stream just sent, so search newest first.
function latestBodies(projection: OrchestrationV2ThreadProjection): DedupedBodySource {
  return {
    messageText: (id) => projection.messages.findLast((message) => message.id === id)?.text,
    checkpointFiles: (id) =>
      projection.checkpoints.findLast((checkpoint) => checkpoint.id === id)?.files,
    subagent: (id) => projection.subagents.findLast((subagent) => subagent.id === id),
  };
}

function removeVisibleItem(
  rows: OrchestrationV2ThreadProjection["visibleTurnItems"],
  sourceItemId: OrchestrationV2TurnItem["id"],
): OrchestrationV2ThreadProjection["visibleTurnItems"] {
  const index = visibleTurnItemIndex(rows, sourceItemId);
  if (index === -1) return rows;
  return renumberVisibleItems([...rows.slice(0, index), ...rows.slice(index + 1)]);
}

function renumberVisibleItems(
  rows: OrchestrationV2ThreadProjection["visibleTurnItems"],
): OrchestrationV2ThreadProjection["visibleTurnItems"] {
  return rows.map((row, position) => (row.position === position ? row : { ...row, position }));
}

function shouldShowLocalTurnItem(
  projection: OrchestrationV2ThreadProjection,
  item: OrchestrationV2TurnItem,
): boolean {
  return isOrchestrationV2TurnItemVisible({
    item,
    runs: projection.runs,
    attempts: projection.attempts,
    items: projection.turnItems,
  });
}

function activeVisibleTurnItems(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection["visibleTurnItems"] {
  const rows = projection.visibleTurnItems;
  const isVisible = createOrchestrationV2TurnItemVisibility({
    runs: projection.runs,
    attempts: projection.attempts,
    items: projection.turnItems,
  });
  let next: Array<(typeof rows)[number]> | null = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const keep = row.visibility !== "local" || isVisible(row.item);
    if (!keep) {
      next ??= rows.slice(0, index);
      continue;
    }
    next?.push(row);
  }
  return next === null ? rows : renumberVisibleItems(next);
}

function oldestLocalTurnOrdinal(
  rows: OrchestrationV2ThreadProjection["visibleTurnItems"],
): number | null {
  let oldest: number | null = null;
  for (const row of rows) {
    if (row.visibility !== "local") continue;
    if (oldest === null || row.item.ordinal < oldest) {
      oldest = row.item.ordinal;
    }
  }
  return oldest;
}

const UNFINISHED_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

function shouldDropMissingPartialTurnItem(
  projection: OrchestrationV2ThreadProjection,
  item: OrchestrationV2TurnItem,
  latestLocalTurnOrdinal: number | null | undefined,
): boolean {
  if (visibleTurnItemIndex(projection.visibleTurnItems, item.id) !== -1) {
    return false;
  }
  if (item.runId === null) {
    return isBelowPartialWindow(projection, item, latestLocalTurnOrdinal);
  }
  // A queued run keeps the ordinal it got when queued, so a steer sent later
  // can raise the watermark past it. Items of a run that has not finished are
  // new, not unloaded history: the first lands while the run is still queued,
  // and a bounded window can start after the ones before it.
  if (
    projection.runs.some((run) => run.id === item.runId && UNFINISHED_RUN_STATUSES.has(run.status))
  ) {
    return false;
  }
  // Later items of a run already in the window can raise the watermark first.
  if (
    projection.visibleTurnItems.some(
      (row) =>
        row.visibility === "local" &&
        row.item.runId === item.runId &&
        row.item.ordinal <= item.ordinal,
    )
  ) {
    return false;
  }
  return isBelowPartialWindow(projection, item, latestLocalTurnOrdinal);
}

function isBelowPartialWindow(
  projection: OrchestrationV2ThreadProjection,
  item: OrchestrationV2TurnItem,
  latestLocalTurnOrdinal: number | null | undefined,
): boolean {
  if (
    latestLocalTurnOrdinal !== null &&
    latestLocalTurnOrdinal !== undefined &&
    item.ordinal <= latestLocalTurnOrdinal
  ) {
    return true;
  }
  const oldest = oldestLocalTurnOrdinal(projection.visibleTurnItems);
  return oldest !== null && item.ordinal < oldest;
}

function upsertVisibleTurnItem(
  projection: OrchestrationV2ThreadProjection,
  item: OrchestrationV2TurnItem,
  partialTimeline: boolean,
  latestLocalTurnOrdinal: number | null | undefined,
): OrchestrationV2ThreadProjection["visibleTurnItems"] {
  const rows = projection.visibleTurnItems;
  const index = visibleTurnItemIndex(rows, item.id);
  const next = {
    position: 0,
    visibility: "local" as const,
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  };
  const previous = index === -1 ? undefined : rows[index]!;
  if (
    previous !== undefined &&
    previous.visibility === next.visibility &&
    previous.sourceThreadId === next.sourceThreadId &&
    previous.sourceItemId === next.sourceItemId &&
    previous.item === item
  ) {
    return rows;
  }
  if (
    previous !== undefined &&
    previous.visibility === "local" &&
    previous.sourceThreadId === item.threadId &&
    previous.item.ordinal === item.ordinal
  ) {
    return replaceVisibleTurnItem(rows, index, { ...next, position: previous.position });
  }
  if (
    index === -1 &&
    partialTimeline &&
    shouldDropMissingPartialTurnItem(projection, item, latestLocalTurnOrdinal)
  ) {
    return rows;
  }
  const updated = index === -1 ? [...rows] : [...rows.slice(0, index), ...rows.slice(index + 1)];
  const insertionIndex = updated.findIndex(
    (row) =>
      row.visibility === "local" &&
      (row.item.ordinal > item.ordinal ||
        (row.item.ordinal === item.ordinal &&
          String(row.item.id).localeCompare(String(item.id)) > 0)),
  );
  updated.splice(insertionIndex === -1 ? updated.length : insertionIndex, 0, next);
  return renumberVisibleItems(updated);
}

/** Applies one committed event to a matching thread projection. */
export function applyOrchestrationV2ProjectionEvent(
  projection: OrchestrationV2ThreadProjection | null,
  event: OrchestrationV2DomainEvent,
  options?: ApplyOrchestrationV2ProjectionEventOptions,
): OrchestrationV2ThreadProjection | null {
  if (projection === null || event.threadId !== projection.thread.id) return projection;

  const partialTimeline = options?.partialTimeline === true;
  const latestLocalTurnOrdinal = options?.latestLocalTurnOrdinal;
  const base = { ...projection, updatedAt: event.occurredAt };
  switch (event.type) {
    case "thread.pull-request-link-updated":
      return {
        ...base,
        thread: applyThreadPullRequestLinkUpdate(projection.thread, event.payload),
      };
    case "thread.created":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
    case "thread.settled":
    case "thread.unsettled":
    case "thread.snoozed":
    case "thread.unsnoozed":
    case "thread.auto-settle-set":
    case "thread.pinned":
    case "thread.unpinned":
    case "thread.pin-reordered":
    case "thread.active-reordered":
    case "thread.metadata-updated":
    case "thread.pull-request-synced":
    case "thread.runtime-mode-updated":
    case "thread.interaction-mode-updated":
    case "thread.model-selection-updated":
    case "thread.provider-switched":
      return { ...base, thread: event.payload };
    // Visited tracking is read state, not activity: skip the updatedAt bump.
    case "thread.visited":
    case "thread.marked-unread":
      return { ...projection, thread: event.payload };
    case "run.created":
    case "run.updated": {
      const next = { ...base, runs: upsertEntity(base.runs, event.payload) };
      return { ...next, visibleTurnItems: activeVisibleTurnItems(next) };
    }
    case "run.background-work-cancelled":
      return {
        ...base,
        runs: base.runs.map((run) =>
          run.id === event.payload.runId
            ? {
                ...run,
                restartCancelledBackgroundWork: event.payload.restartCancelledBackgroundWork,
              }
            : run,
        ),
      };
    case "run-attempt.created":
    case "run-attempt.updated": {
      const next = { ...base, attempts: upsertEntity(base.attempts, event.payload) };
      return { ...next, visibleTurnItems: activeVisibleTurnItems(next) };
    }
    case "node.updated":
      return { ...base, nodes: upsertEntity(base.nodes, event.payload) };
    case "subagent.updated":
      return {
        ...base,
        subagents: upsertEntity(
          base.subagents,
          restoreSubagentBodies(
            event.payload,
            base.subagents.find((subagent) => subagent.id === event.payload.id),
          ),
        ),
      };
    case "provider-session.attached":
    case "provider-session.updated":
      return {
        ...base,
        providerSessions: upsertEntity(base.providerSessions, event.payload),
      };
    case "provider-session.detached":
      return {
        ...base,
        providerSessions: base.providerSessions.filter(
          (session) => session.id !== event.payload.providerSessionId,
        ),
      };
    case "provider-thread.updated":
      return {
        ...base,
        thread:
          event.payload.appThreadId === base.thread.id &&
          !isQueuedProviderThreadPlaceholder(event.payload)
            ? { ...base.thread, activeProviderThreadId: event.payload.id }
            : base.thread,
        providerThreads: upsertEntity(base.providerThreads, event.payload),
      };
    case "provider-turn.updated": {
      // Updates that omit live usage or the generation rate keep the last ones reported.
      const current = base.providerTurns.find((turn) => turn.id === event.payload.id);
      const tokenUsage = event.payload.tokenUsage ?? current?.tokenUsage;
      const generation = event.payload.generation ?? current?.generation;
      return {
        ...base,
        providerTurns: upsertEntity(base.providerTurns, {
          ...event.payload,
          ...(tokenUsage === undefined ? {} : { tokenUsage }),
          ...(generation === undefined ? {} : { generation }),
        }),
      };
    }
    case "runtime-request.updated":
      return { ...base, runtimeRequests: upsertEntity(base.runtimeRequests, event.payload) };
    case "message.updated":
      return { ...base, messages: upsertEntity(base.messages, event.payload) };
    case "plan.updated":
      return { ...base, plans: upsertEntity(base.plans, event.payload) };
    case "turn-item.updated": {
      const payload = restoreTurnItemBodies(event.payload, latestBodies(projection));
      if (
        partialTimeline &&
        entityIndex(projection.turnItems, payload.id) === -1 &&
        shouldDropMissingPartialTurnItem(projection, payload, latestLocalTurnOrdinal)
      ) {
        return projection;
      }
      const next = { ...base, turnItems: upsertEntity(base.turnItems, payload) };
      // Only interrupt requests can change another item's visibility. Streaming
      // text/tool updates must not recheck every row against every run.
      const previous = projection.turnItems[entityIndex(projection.turnItems, event.payload.id)];
      const visible =
        payload.type === "run_interrupt_request" || previous?.type === "run_interrupt_request"
          ? { ...next, visibleTurnItems: activeVisibleTurnItems(next) }
          : next;
      return {
        ...next,
        visibleTurnItems: shouldShowLocalTurnItem(next, payload)
          ? upsertVisibleTurnItem(visible, payload, partialTimeline, latestLocalTurnOrdinal)
          : removeVisibleItem(visible.visibleTurnItems, payload.id),
      };
    }
    case "checkpoint-scope.created":
      return { ...base, checkpointScopes: upsertEntity(base.checkpointScopes, event.payload) };
    case "checkpoint.captured":
      return { ...base, checkpoints: upsertEntity(base.checkpoints, event.payload) };
    case "checkpoint.rollback-requested":
      return base;
    case "context-handoff.updated":
      return { ...base, contextHandoffs: upsertEntity(base.contextHandoffs, event.payload) };
    case "context-transfer.created":
    case "context-transfer.updated":
      return { ...base, contextTransfers: upsertEntity(base.contextTransfers, event.payload) };
  }
}
