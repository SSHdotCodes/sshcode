import { StoredOrchestrationThreadSnapshot } from "@t3tools/client-runtime/platform";
import { OrchestrationV2ThreadProjection, OrchestrationV2TurnItem } from "@t3tools/contracts";
import { boundedSnapshotProjection } from "@t3tools/shared/orchestrationV2BoundedSnapshot";
import { dedupeSnapshotBodies } from "@t3tools/shared/orchestrationV2DedupedBodies";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// A separate web cache version prevents an older app from reading compacted
// bodies without restoring them. The existing shared format is still readable.
export const WEB_THREAD_CACHE_SCHEMA_VERSION = 6;
const CompactStoredThreadSnapshot = StoredOrchestrationThreadSnapshot.mapFields((fields) => ({
  ...fields,
  schemaVersion: Schema.Literal(WEB_THREAD_CACHE_SCHEMA_VERSION),
  snapshot: fields.snapshot.mapFields((snapshotFields) => ({
    ...snapshotFields,
    projection: Schema.toCodecJson(OrchestrationV2ThreadProjection),
    turnItemsOmitLocalVisible: Schema.optionalKey(Schema.Literal(true)),
  })),
}));
const encodeCompact = Schema.encodeEffect(Schema.fromJsonString(CompactStoredThreadSnapshot));
const decodeStored = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([StoredOrchestrationThreadSnapshot, CompactStoredThreadSnapshot]),
  ),
);
const sameTurnItem = Schema.toEquivalence(OrchestrationV2TurnItem);

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

export const encodeStoredThreadSnapshot = Effect.fnUntraced(function* (
  stored: typeof StoredOrchestrationThreadSnapshot.Type,
) {
  const projection = dedupeSnapshotBodies(stored.snapshot.projection);
  const compact = compactLocalItems(projection);
  return yield* encodeCompact({
    ...stored,
    schemaVersion: WEB_THREAD_CACHE_SCHEMA_VERSION,
    snapshot: {
      ...stored.snapshot,
      projection: compact ?? projection,
      ...(compact === null ? {} : { turnItemsOmitLocalVisible: true }),
    },
  });
});

export const decodeStoredThreadSnapshot = Effect.fnUntraced(function* (raw: string) {
  const stored = yield* decodeStored(raw);
  if (stored.schemaVersion !== WEB_THREAD_CACHE_SCHEMA_VERSION) return stored;
  const { turnItemsOmitLocalVisible, ...snapshot } = stored.snapshot;
  return {
    ...stored,
    snapshot: {
      ...snapshot,
      projection: boundedSnapshotProjection({ ...snapshot, turnItemsOmitLocalVisible }),
    },
  };
});
