import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";

import { omitLocalVisibleTurnItems } from "@t3tools/shared/orchestrationV2BoundedSnapshot";
import { dedupeSnapshotBodies } from "@t3tools/shared/orchestrationV2DedupedBodies";

import {
  buildBoundedThreadProjection,
  clampSnapshotUserTurnLimit,
  THREAD_HISTORY_PAGE_POLICY,
  type BoundedProjectionResult,
} from "./threadHistoryPaging.ts";
import { projectThreadProjectionForWire } from "./WireProjection.ts";

/** Maximum number of reducer applications allowed during a thread resume. */
export const THREAD_RESUME_MAX_REPLAY_EVENTS = 2_048;

/** Bound preflight queries and decoding even for tiny persisted events. */
export const THREAD_RESUME_MAX_SOURCE_EVENTS = 8_192;

/** Preserve the cheap path for small gaps without reading a snapshot to compare. */
export const THREAD_RESUME_SNAPSHOT_COMPARE_EVENTS = 128;

/** Maximum encoded event JSON allowed during a thread resume. */
export const THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES = 1_048_576;

/**
 * Maximum aggregate persisted payload JSON decoded for one thread resume.
 * Allow several minutes of streaming updates to compact, while bounding laptop
 * decoding work. Decoded objects cost more than stored JSON; never decode an
 * unbounded range just because its final wire representation might be small.
 */
export const THREAD_RESUME_MAX_RAW_PAYLOAD_BYTES = 8 * 1_048_576;

/** Resource-safety check applied before persisted replay payloads are decoded. */
export function isThreadReplayRawPayloadSafe(rawPayloadBytes: number): boolean {
  return rawPayloadBytes <= THREAD_RESUME_MAX_RAW_PAYLOAD_BYTES;
}

/** Encoded payload cost after events have been projected for the wire. */
export function threadReplayEncodedBytes(
  items: ReadonlyArray<unknown>,
  limit: number = THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES,
): number {
  let total = 0;
  for (const item of items) {
    const encoded = JSON.stringify(item);
    total += Buffer.byteLength(encoded ?? "", "utf8");
    if (total > limit) break;
  }
  return total;
}

type ThreadSnapshotStreamItem = Extract<
  OrchestrationV2ThreadStreamItem,
  { readonly kind: "snapshot" }
>;

/**
 * Bounded snapshot fields shared by the HTTP route and socket fallbacks. Only
 * clients that opted in get compact `turnItems` and the marker; everyone else
 * gets the unchanged representation.
 */
export function boundedSnapshotResponseFields(input: {
  readonly bounded: BoundedProjectionResult;
  readonly compactTurnItems: boolean;
  readonly dedupeBodies: boolean;
  readonly compactIds: boolean;
}) {
  const { bounded } = input;
  // Dedupe keeps shared items one object, which the compaction's identity check needs.
  const projection = input.dedupeBodies
    ? dedupeSnapshotBodies(bounded.projection)
    : bounded.projection;
  const compactProjection = input.compactTurnItems ? omitLocalVisibleTurnItems(projection) : null;
  return {
    projection: compactProjection ?? projection,
    historyCursor: bounded.historyCursor,
    hasMoreHistory: bounded.hasMoreHistory,
    latestLocalTurnOrdinal: bounded.latestLocalTurnOrdinal,
    ...(compactProjection === null ? {} : { turnItemsOmitLocalVisible: true as const }),
    ...(input.compactIds ? { idTable: true as const } : {}),
  };
}

/** Build the same bounded, wire-projected snapshot for every socket fallback path. */
export function buildBoundedThreadStreamSnapshot(input: {
  readonly snapshotSequence: number;
  readonly projection: OrchestrationV2ThreadProjection;
  readonly compactTurnItems?: boolean;
  readonly snapshotUserTurnLimit?: number;
  readonly dedupeBodies?: boolean;
  readonly compactIds?: boolean;
}): ThreadSnapshotStreamItem {
  const bounded = buildBoundedThreadProjection({
    snapshotSequence: input.snapshotSequence,
    projection: projectThreadProjectionForWire(input.projection),
    policy: {
      ...THREAD_HISTORY_PAGE_POLICY,
      maxUserTurns: clampSnapshotUserTurnLimit(input.snapshotUserTurnLimit),
    },
  });
  return {
    kind: "snapshot",
    snapshotSequence: input.snapshotSequence,
    ...boundedSnapshotResponseFields({
      bounded,
      compactTurnItems: input.compactTurnItems === true,
      dedupeBodies: input.dedupeBodies === true,
      compactIds: input.compactIds === true,
    }),
  };
}

export type ThreadResumePlan =
  | {
      readonly mode: "replay";
      readonly afterSequence: number;
      readonly throughSequence: number;
    }
  | { readonly mode: "snapshot" };

/**
 * Decide whether a thread subscription should replay the event gap after the
 * client's cursor or send a fresh snapshot instead.
 *
 * A client cursor above the high water mark is stale or invalid. Event count
 * limits reducer churn while encoded bytes limit a small number of large
 * updates. Either excess is cheaper to replace with one current snapshot.
 */
export function decideThreadResume(input: {
  readonly afterSequence: number;
  readonly highWater: number;
  readonly replayEventCount: number;
  readonly replayEncodedBytes: number;
  readonly snapshotEncodedBytes?: number;
}): ThreadResumePlan {
  if (
    input.afterSequence > input.highWater ||
    input.replayEventCount > THREAD_RESUME_MAX_REPLAY_EVENTS ||
    input.replayEncodedBytes > THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES ||
    (input.snapshotEncodedBytes !== undefined &&
      input.replayEncodedBytes > input.snapshotEncodedBytes * 0.8)
  ) {
    return { mode: "snapshot" };
  }
  return {
    mode: "replay",
    afterSequence: input.afterSequence,
    throughSequence: input.highWater,
  };
}

type ReplayEvent = Extract<OrchestrationV2ThreadStreamItem, { readonly kind: "event" }>;

/** Full replacements with no cross-entity reducer effects. Everything else stays intact. */
function replacementKey(event: OrchestrationV2DomainEvent): string | null {
  switch (event.type) {
    case "node.updated":
    case "subagent.updated":
    case "provider-session.updated":
    case "provider-thread.updated":
    case "runtime-request.updated":
    case "message.updated":
    case "plan.updated":
    case "context-handoff.updated":
    case "context-transfer.updated":
      return `${event.threadId}:${event.type}:${event.payload.id}`;
    case "provider-turn.updated":
      // Omitted tokenUsage and generation inherit the preceding values in the
      // client reducer. Keep the last explicit value AND the last state without it.
      return `${event.threadId}:${event.type}:${event.payload.id}:${event.payload.tokenUsage === undefined}:${event.payload.generation === undefined}`;
    default:
      return null;
  }
}

/**
 * Keep original sequence order and the first insertion of each entity. The
 * reducer appends missing entities, so keeping only their last occurrence would
 * reorder arrays. Subsequent full replacements collapse to the last state.
 *
 * Run/attempt changes and interrupt requests can irreversibly filter visible
 * rows or change partial-window admission. Never compact turn items across
 * those barriers, or across changes to an item's structural/visibility fields.
 * Wire projection is stateless and preserves those fields.
 */
export function compactThreadReplay(items: ReadonlyArray<ReplayEvent>): ReplayEvent[] {
  const keep = items.map(() => true);
  const replacements = new Map<string, { first: number; last: number }>();
  const turnItems = new Map<string, { first: number; last: number }>();
  const itemShapes = new Map<string, string>();
  const record = (
    map: Map<string, { first: number; last: number }>,
    key: string,
    index: number,
  ) => {
    const previous = map.get(key);
    if (previous === undefined) {
      map.set(key, { first: index, last: index });
    } else {
      if (previous.last !== previous.first) keep[previous.last] = false;
      previous.last = index;
    }
  };
  for (const [index, { event }] of items.entries()) {
    const key = replacementKey(event);
    if (key !== null) {
      record(replacements, key, index);
      continue;
    }
    switch (event.type) {
      case "turn-item.updated": {
        const item = event.payload;
        if (item.type === "run_interrupt_request") {
          itemShapes.delete(`${event.threadId}:${item.id}`);
          turnItems.clear();
          break;
        }
        const id = `${event.threadId}:${item.id}`;
        const shape = JSON.stringify([
          item.type,
          item.ordinal,
          item.runId,
          item.nodeId,
          item.type === "user_message" ? item.inputIntent : null,
        ]);
        // The first observed state may replace an interrupt request already in
        // the cache. Structural changes can alter another row's visibility or
        // admission, so preserve all pending items across that boundary too.
        if (itemShapes.get(id) !== shape) {
          turnItems.clear();
          itemShapes.set(id, shape);
        }
        record(turnItems, id, index);
        break;
      }
      case "run.created":
      case "run.updated":
      case "run.background-work-cancelled":
      case "run-attempt.created":
      case "run-attempt.updated":
        turnItems.clear();
        break;
      default:
        // Creates, deletes, patches, and future event kinds are barriers. This
        // also prevents compacting a session update across detach/reattach.
        replacements.clear();
        turnItems.clear();
        itemShapes.clear();
        break;
    }
  }
  return items.filter((_, index) => keep[index]);
}
