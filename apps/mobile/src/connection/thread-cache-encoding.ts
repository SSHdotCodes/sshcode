import {
  makeThreadCacheRowEncoder,
  StoredOrchestrationThreadSnapshot,
} from "@t3tools/client-runtime/platform";
import { OrchestrationV2ThreadProjection, OrchestrationV2TurnItem } from "@t3tools/contracts";
import { boundedSnapshotProjection } from "@t3tools/shared/orchestrationV2BoundedSnapshot";
import { dedupeSnapshotBodies } from "@t3tools/shared/orchestrationV2DedupedBodies";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// A separate mobile cache version prevents an older app from reading compacted
// bodies without restoring them. The existing shared format is still readable.
export const MOBILE_THREAD_CACHE_SCHEMA_VERSION = 6;
const CompactStoredThreadSnapshot = StoredOrchestrationThreadSnapshot.mapFields((fields) => ({
  ...fields,
  schemaVersion: Schema.Literal(MOBILE_THREAD_CACHE_SCHEMA_VERSION),
  firstScreen: Schema.optionalKey(Schema.String),
  snapshot: fields.snapshot.mapFields((snapshotFields) => ({
    ...snapshotFields,
    projection: Schema.toCodecJson(OrchestrationV2ThreadProjection),
    turnItemsOmitLocalVisible: Schema.optionalKey(Schema.Literal(true)),
  })),
}));
const MAX_JSON_LENGTH = 4 * 1024 * 1024;
const ProjectionJson = OrchestrationV2ThreadProjection.mapFields((fields) => ({
  thread: Schema.toCodecJson(fields.thread),
  runs: Schema.toCodecJson(fields.runs),
  attempts: Schema.toCodecJson(fields.attempts),
  nodes: Schema.toCodecJson(fields.nodes),
  subagents: Schema.toCodecJson(fields.subagents),
  providerSessions: Schema.toCodecJson(fields.providerSessions),
  providerThreads: Schema.toCodecJson(fields.providerThreads),
  providerTurns: Schema.toCodecJson(fields.providerTurns),
  runtimeRequests: Schema.toCodecJson(fields.runtimeRequests),
  messages: Schema.toCodecJson(fields.messages),
  plans: Schema.toCodecJson(fields.plans),
  turnItems: Schema.toCodecJson(fields.turnItems),
  checkpointScopes: Schema.toCodecJson(fields.checkpointScopes),
  checkpoints: Schema.toCodecJson(fields.checkpoints),
  contextHandoffs: Schema.toCodecJson(fields.contextHandoffs),
  contextTransfers: Schema.toCodecJson(fields.contextTransfers),
  visibleTurnItems: Schema.toCodecJson(fields.visibleTurnItems),
  updatedAt: Schema.toCodecJson(fields.updatedAt),
}));
const EncodedRows = Schema.Array(Schema.Unknown);
// Large message, work-log and run arrays pass through their canonical codecs in chunks.
const encodeCompact = Schema.encodeEffect(
  Schema.fromJsonString(
    CompactStoredThreadSnapshot.mapFields((fields) => ({
      ...fields,
      snapshot: fields.snapshot.mapFields((snapshot) => ({
        ...snapshot,
        projection: ProjectionJson.mapFields((projection) => ({
          ...projection,
          runs: EncodedRows,
          attempts: EncodedRows,
          nodes: EncodedRows,
          messages: EncodedRows,
          checkpoints: EncodedRows,
          plans: EncodedRows,
          contextHandoffs: EncodedRows,
          subagents: EncodedRows,
          turnItems: EncodedRows,
          visibleTurnItems: EncodedRows,
        })),
      })),
    })),
  ),
);
const rowCodecs = {
  runs: Schema.encodeEffect(ProjectionJson.fields.runs),
  attempts: Schema.encodeEffect(ProjectionJson.fields.attempts),
  nodes: Schema.encodeEffect(ProjectionJson.fields.nodes),
  messages: Schema.encodeEffect(ProjectionJson.fields.messages),
  checkpoints: Schema.encodeEffect(ProjectionJson.fields.checkpoints),
  plans: Schema.encodeEffect(ProjectionJson.fields.plans),
  contextHandoffs: Schema.encodeEffect(ProjectionJson.fields.contextHandoffs),
  subagents: Schema.encodeEffect(ProjectionJson.fields.subagents),
  turnItems: Schema.encodeEffect(ProjectionJson.fields.turnItems),
  visibleTurnItems: Schema.encodeEffect(ProjectionJson.fields.visibleTurnItems),
};
const decodeStored = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([StoredOrchestrationThreadSnapshot, CompactStoredThreadSnapshot]),
  ),
);
const sameTurnItem = Schema.toEquivalence(OrchestrationV2TurnItem);

/** A display-only tail; the complete copy below retains every row and cursor. */
function firstScreenProjection(projection: OrchestrationV2ThreadProjection) {
  const visibleTurnItems = projection.visibleTurnItems.slice(-16);
  const items = new Set(visibleTurnItems.map((row) => row.sourceItemId));
  const runIds = new Set(visibleTurnItems.map((row) => row.item.runId));
  const runs = projection.runs.filter(
    (run) =>
      runIds.has(run.id) || ["preparing", "starting", "running", "waiting"].includes(run.status),
  );
  const nodeIds = new Set(visibleTurnItems.map((row) => row.item.nodeId));
  for (const run of runs) nodeIds.add(run.rootNodeId);
  const messageIds = new Set(runs.map((run) => run.userMessageId));
  const checkpointIds = new Set(runs.map((run) => run.checkpointId));
  const planIds = new Set<string>();
  for (const { item } of visibleTurnItems) {
    if (item.type === "user_message" || item.type === "assistant_message")
      messageIds.add(item.messageId);
    if (item.type === "checkpoint") checkpointIds.add(item.checkpointId);
    if (item.type === "proposed_plan" || item.type === "todo_list") planIds.add(item.planId);
  }
  return {
    ...projection,
    runs,
    attempts: projection.attempts.filter((attempt) => runs.some((run) => run.id === attempt.runId)),
    nodes: projection.nodes.filter((node) => nodeIds.has(node.id)),
    messages: projection.messages.filter((message) => messageIds.has(message.id)),
    checkpoints: projection.checkpoints.filter((checkpoint) => checkpointIds.has(checkpoint.id)),
    plans: projection.plans.filter((plan) => planIds.has(plan.id)),
    contextHandoffs: projection.contextHandoffs.filter((handoff) =>
      runs.some((run) => run.contextHandoffId === handoff.id),
    ),
    turnItems: projection.turnItems.filter((item) => items.has(item.id)),
    visibleTurnItems,
  };
}

function compactLocalItems(projection: OrchestrationV2ThreadProjection) {
  let omitted = 0;
  for (const row of projection.visibleTurnItems) {
    if (row.visibility !== "local" && row.sourceThreadId !== projection.thread.id) continue;
    const item = projection.turnItems[omitted];
    // A legacy cache was parsed twice, so equal rows need not share an object.
    // Hidden or differently ordered items must stay in the persisted array.
    if (item === undefined || (item !== row.item && !sameTurnItem(item, row.item))) return null;
    omitted++;
  }
  return omitted === 0 ? null : { ...projection, turnItems: projection.turnItems.slice(omitted) };
}

export function makeStoredThreadSnapshotEncoder() {
  const makeRows = makeThreadCacheRowEncoder();
  const encodeProjection = Effect.fnUntraced(function* (
    projection: OrchestrationV2ThreadProjection,
  ) {
    const rows = makeRows();
    const runs = yield* rows(projection.runs, rowCodecs.runs);
    if (runs === undefined) return undefined;
    const attempts = yield* rows(projection.attempts, rowCodecs.attempts);
    if (attempts === undefined) return undefined;
    const nodes = yield* rows(projection.nodes, rowCodecs.nodes);
    if (nodes === undefined) return undefined;
    const messages = yield* rows(projection.messages, rowCodecs.messages);
    if (messages === undefined) return undefined;
    const checkpoints = yield* rows(projection.checkpoints, rowCodecs.checkpoints);
    if (checkpoints === undefined) return undefined;
    const plans = yield* rows(projection.plans, rowCodecs.plans);
    if (plans === undefined) return undefined;
    const contextHandoffs = yield* rows(projection.contextHandoffs, rowCodecs.contextHandoffs);
    if (contextHandoffs === undefined) return undefined;
    const subagents = yield* rows(projection.subagents, rowCodecs.subagents);
    if (subagents === undefined) return undefined;
    const turnItems = yield* rows(projection.turnItems, rowCodecs.turnItems);
    if (turnItems === undefined) return undefined;
    const visibleTurnItems = yield* rows(projection.visibleTurnItems, rowCodecs.visibleTurnItems);
    if (visibleTurnItems === undefined) return undefined;
    return {
      ...projection,
      runs,
      attempts,
      nodes,
      messages,
      checkpoints,
      plans,
      contextHandoffs,
      subagents,
      turnItems,
      visibleTurnItems,
    };
  });
  return Effect.fnUntraced(function* (stored: typeof StoredOrchestrationThreadSnapshot.Type) {
    const projection = dedupeSnapshotBodies(stored.snapshot.projection);
    const compact = compactLocalItems(projection);
    const encodedProjection = yield* encodeProjection(compact ?? projection);
    if (encodedProjection === undefined) return undefined;
    const full = yield* encodeCompact({
      ...stored,
      schemaVersion: MOBILE_THREAD_CACHE_SCHEMA_VERSION,
      snapshot: {
        ...stored.snapshot,
        projection: encodedProjection,
        ...(compact === null ? {} : { turnItemsOmitLocalVisible: true }),
      },
    });
    if (full.length > MAX_JSON_LENGTH) return undefined;
    if (full.length <= 64 * 1024) return full;
    const first = dedupeSnapshotBodies(firstScreenProjection(stored.snapshot.projection));
    const compactFirst = compactLocalItems(first);
    const encodedFirst = yield* encodeProjection(compactFirst ?? first);
    if (encodedFirst === undefined) return undefined;
    const firstScreen = yield* encodeCompact({
      ...stored,
      schemaVersion: MOBILE_THREAD_CACHE_SCHEMA_VERSION,
      snapshot: {
        // This copy is display-only. Never give it the full copy's paging cursor.
        snapshotSequence: stored.snapshot.snapshotSequence,
        projection: encodedFirst,
        ...(compactFirst === null ? {} : { turnItemsOmitLocalVisible: true }),
      },
    });
    // Both values are encoded objects. Append the optional field without parsing
    // and validating the complete snapshot a second time during persistence.
    const payload = `${full.slice(0, -1)},"firstScreen":${JSON.stringify(firstScreen)}}`;
    return payload.length > MAX_JSON_LENGTH ? undefined : payload;
  });
}

export const encodeStoredThreadSnapshot = makeStoredThreadSnapshotEncoder();

export const decodeStoredThreadSnapshot = Effect.fnUntraced(function* (raw: string) {
  const stored = yield* decodeStored(raw);
  if (stored.schemaVersion !== MOBILE_THREAD_CACHE_SCHEMA_VERSION) return stored;
  const { firstScreen: _firstScreen, ...complete } = stored;
  const { turnItemsOmitLocalVisible, ...snapshot } = complete.snapshot;
  return {
    ...complete,
    snapshot: {
      ...snapshot,
      projection: boundedSnapshotProjection({ ...snapshot, turnItemsOmitLocalVisible }),
    },
  };
});
