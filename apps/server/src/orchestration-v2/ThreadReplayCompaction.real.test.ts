/** Opt-in proof against a disposable /tmp backup. No private transcript fixtures are committed. */
import * as NodeSqlite from "node:sqlite";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as FileSystem from "effect/FileSystem";
import * as NodeZlib from "node:zlib";
import * as NodePerfHooks from "node:perf_hooks";
import {
  OrchestrationV2DomainEventJson,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, it } from "@effect/vitest";

import { applyOrchestrationV2ProjectionEvent } from "../../../../packages/client-runtime/src/state/orchestrationV2Projection.ts";
import { v2Projection } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  buildBoundedThreadStreamSnapshot,
  compactThreadReplay,
  decideThreadResume,
  isThreadReplayRawPayloadSafe,
  threadReplayEncodedBytes,
  THREAD_RESUME_MAX_SOURCE_EVENTS,
} from "./ThreadStream.ts";
import { THREAD_HISTORY_SNAPSHOT_ROW_LIMIT } from "./threadHistoryPaging.ts";
import { projectDomainEventForWire } from "./WireProjection.ts";

type ReplayEvent = Extract<OrchestrationV2ThreadStreamItem, { kind: "event" }>;
const dbPath = process.env.THREAD_RESUME_TEST_DB;
const threadIds = (process.env.THREAD_RESUME_TEST_THREADS ?? "").split(",").filter(Boolean);
const decode = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson);
function fold(
  start: OrchestrationV2ThreadProjection,
  items: ReadonlyArray<ReplayEvent>,
  partial = false,
  watermark = 0,
) {
  let projection = start;
  for (const { event } of items) {
    projection = applyOrchestrationV2ProjectionEvent(
      projection,
      event,
      partial ? { partialTimeline: true, latestLocalTurnOrdinal: watermark } : undefined,
    )!;
    if (event.type === "turn-item.updated") watermark = Math.max(watermark, event.payload.ordinal);
  }
  return projection;
}
function size(value: unknown) {
  const json = JSON.stringify(value);
  return { raw: Buffer.byteLength(json), deflateRaw: NodeZlib.deflateRawSync(json).byteLength };
}

it.live.skipIf(!dbPath || threadIds.length === 0)(
  "real replay equals full replay at timed and mid-turn cursors",
  () =>
    Effect.gen(function* () {
      if (!dbPath?.startsWith("/tmp/")) throw new Error("Use a disposable /tmp backup");
      const db = yield* Effect.acquireRelease(
        Effect.sync(
          () => new NodeSqlite.DatabaseSync(`file:${dbPath}?immutable=1`, { readOnly: true }),
        ),
        (db) => Effect.sync(() => db.close()),
      );
      const reports: unknown[] = [];
      for (const id of threadIds) {
        const rows = db
          .prepare(`SELECT sequence, event_id, event_type, stream_id, occurred_at, metadata_json,
        CASE WHEN event_type IN ('subagent.updated','turn-item.updated') AND json_type(payload_json,'$.promptSequence')='integer'
        THEN json_set(json_remove(payload_json,'$.promptSequence'), '$.prompt',
          (SELECT json_extract(anchor.payload_json,'$.prompt') FROM orchestration_events anchor
           WHERE anchor.sequence=json_extract(orchestration_events.payload_json,'$.promptSequence')))
        ELSE payload_json END AS payload_json
        FROM orchestration_events WHERE aggregate_kind='thread' AND application_event_version=2 AND stream_id=? ORDER BY sequence`)
          .all(id) as Array<{
          sequence: number;
          event_id: string;
          event_type: string;
          stream_id: string;
          occurred_at: string;
          metadata_json: string;
          payload_json: string;
        }>;
        const decodeRow = (row: (typeof rows)[number]): ReplayEvent => ({
          kind: "event",
          sequence: row.sequence,
          event: projectDomainEventForWire(
            decode({
              ...JSON.parse(row.metadata_json),
              id: row.event_id,
              type: row.event_type,
              threadId: row.stream_id,
              occurredAt: row.occurred_at,
              payload: JSON.parse(row.payload_json),
            }),
          ),
        });
        const items = rows.map(decodeRow);
        const first = items[0]!.event;
        if (first.type !== "thread.created") throw new Error("Backup must retain thread creation");
        const head = items.at(-1)!.sequence;
        const endTime = Date.parse(rows.at(-1)!.occurred_at);
        const cursors = [5, 15, 45].map((minutes) => ({
          minutes,
          index:
            rows.findLastIndex((row) => Date.parse(row.occurred_at) <= endTime - minutes * 60_000) +
            1,
        }));
        for (const index of [
          items.findLastIndex(
            ({ event }) => event.type === "turn-item.updated" && event.payload.status === "running",
          ),
          items.findLastIndex(({ event }) => event.type === "run.updated"),
        ])
          if (index > 0) cursors.push({ minutes: 0, index });
        const windows = yield* Effect.gen(function* () {
          const store = yield* ProjectionStore.ProjectionStoreV2;
          const snapshots = [];
          for (const limit of [10, 3]) {
            const snapshot = yield* store.getThreadSnapshotWindow(ThreadId.make(id), {
              rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
              userTurnLimit: limit,
            });
            snapshots.push(
              buildBoundedThreadStreamSnapshot({
                ...snapshot,
                compactTurnItems: true,
                snapshotUserTurnLimit: limit,
              }),
            );
          }
          return snapshots;
        }).pipe(
          Effect.provide(
            ProjectionStore.layer.pipe(
              Layer.provide(
                NodeSqliteClient.layer({
                  filename: `file:${dbPath}?immutable=1`,
                  readonly: true,
                }),
              ),
            ),
          ),
        );
        const [ten, three] = windows;
        const measurements = [];
        let prefix = { ...v2Projection, thread: first.payload, updatedAt: first.occurredAt };
        let previous = 0;
        for (const { minutes, index } of cursors.toSorted((a, b) => a.index - b.index)) {
          prefix = fold(prefix, items.slice(previous, index));
          previous = index;
          const replay = items.slice(index);
          const start = NodePerfHooks.performance.now();
          const compacted = compactThreadReplay(replay);
          const compactMs = NodePerfHooks.performance.now() - start;
          expect(fold(prefix, compacted), `full ${id}:${index}`).toEqual(fold(prefix, replay));
          const partial = buildBoundedThreadStreamSnapshot({
            snapshotSequence: rows[index - 1]!.sequence,
            projection: prefix,
            snapshotUserTurnLimit: 3,
          });
          expect(
            fold(partial.projection, compacted, true, partial.latestLocalTurnOrdinal ?? 0),
            `partial ${id}:${index}`,
          ).toEqual(fold(partial.projection, replay, true, partial.latestLocalTurnOrdinal ?? 0));
          if (minutes === 0) continue;
          const rawPayloadBytes = rows
            .slice(index)
            .reduce((sum, row) => sum + Buffer.byteLength(row.payload_json), 0);
          const decodeStart = NodePerfHooks.performance.now();
          rows.slice(index).map(decodeRow);
          const decodeProjectMs = NodePerfHooks.performance.now() - decodeStart;
          const afterSequence = rows[index - 1]!.sequence;
          const oldReplay =
            replay.length <= 128 &&
            rawPayloadBytes <= 1_048_576 &&
            threadReplayEncodedBytes(replay) <= 1_048_576;
          const plan = decideThreadResume({
            afterSequence,
            highWater: head,
            replayEventCount: compacted.length,
            replayEncodedBytes: threadReplayEncodedBytes(compacted),
            snapshotEncodedBytes: threadReplayEncodedBytes([three]),
          });
          const newReplay =
            replay.length <= THREAD_RESUME_MAX_SOURCE_EVENTS &&
            isThreadReplayRawPayloadSafe(rawPayloadBytes) &&
            plan.mode === "replay";
          measurements.push({
            minutes,
            sourceEvents: replay.length,
            compactedEvents: compacted.length,
            rawPayloadBytes,
            compactMs,
            decodeProjectMs,
            beforeMode: oldReplay ? "replay" : "snapshot",
            before: size(oldReplay ? replay : [ten]),
            afterMode: newReplay ? "replay" : "snapshot",
            after: size(newReplay ? compacted : [three]),
            fullReplay: size(replay),
            compactedReplay: size(compacted),
          });
        }
        reports.push({
          threadId: id,
          highWater: head,
          endTime: rows.at(-1)!.occurred_at,
          window10: size([ten]),
          window3: size([three]),
          window10Items: ten!.projection.visibleTurnItems.length,
          window3Items: three!.projection.visibleTurnItems.length,
          cursorsVerified: cursors.length,
          measurements,
        });
      }
      const reportPath = process.env.THREAD_RESUME_TEST_REPORT;
      if (reportPath)
        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(reportPath, JSON.stringify(reports, null, 2));
        }).pipe(Effect.provide(NodeFileSystem.layer));
    }).pipe(Effect.scoped),
  180_000,
);
