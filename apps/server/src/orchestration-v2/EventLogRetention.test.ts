import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventLogRetention from "./EventLogRetention.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const OLD = "2026-10-01T00:00:00.000Z";
const RECENT = "2026-11-19T00:00:00.000Z";
const CUTOFF = Date.parse("2026-11-12T00:00:00.000Z");

const remainingSequences = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly sequence: number }>`
    SELECT sequence FROM orchestration_events ORDER BY sequence
  `;
  return rows.map((row) => row.sequence);
});

describe("expiredRange", () => {
  it.effect("ends at the first recent event and counts an unreadable date as old", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const row = (ordinal: number, occurredAt: string) => ({
        event_id: `event:${ordinal}`,
        aggregate_kind: "thread",
        stream_id: "thread-1",
        stream_version: ordinal,
        event_type: "node.updated",
        occurred_at: occurredAt,
        actor_kind: "server",
        payload_json: "{}",
        metadata_json: "{}",
        application_event_version: 2,
      });
      yield* sql`INSERT INTO orchestration_events ${sql.insert([
        row(1, OLD),
        row(2, "not a date"),
        row(3, RECENT),
        // Older than the event before it; still after the floor.
        row(4, OLD),
      ])}`;

      expect(
        yield* EventLogRetention.expiredRange({ fromSequence: 0, cutoffMillis: CUTOFF }),
      ).toEqual({ belowSequence: 3, done: true });
      // A full slice of old events leaves the rest for the next slice.
      expect(
        yield* EventLogRetention.expiredRange({ fromSequence: 0, cutoffMillis: CUTOFF, limit: 2 }),
      ).toEqual({ belowSequence: 3, done: false });
      expect(
        yield* EventLogRetention.expiredRange({
          fromSequence: 4,
          cutoffMillis: Date.parse("2027-01-01T00:00:00.000Z"),
        }),
      ).toEqual({ belowSequence: 5, done: true });
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});

it.effect(
  "keeps creations, newest events, subagent prompts, pending legacy imports and projects",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      let version = 0;
      const row = (
        stream: string,
        eventType: string,
        payload: object,
        occurredAt = OLD,
        aggregateKind = "thread",
      ) => ({
        event_id: `event:${(version += 1)}`,
        aggregate_kind: aggregateKind,
        stream_id: stream,
        stream_version: version,
        event_type: eventType,
        occurred_at: occurredAt,
        actor_kind: "server",
        payload_json: encodeJson(payload),
        metadata_json: "{}",
        application_event_version: 2,
      });
      yield* sql`INSERT INTO orchestration_events ${sql.insert([
        row("old", "thread.created", { id: "old" }),
        row("old", "node.updated", { id: "node" }),
        row("old", "turn-item.updated", { id: "tool", type: "command_execution" }),
        row("old", "subagent.updated", { id: "sub", prompt: "Prompt" }),
        row("old", "subagent.updated", { id: "sub", prompt: "", promptSequence: 4 }),
        row("old", "turn-item.updated", { id: "item:sub", type: "subagent", prompt: "Prompt" }),
        row("old", "turn-item.updated", {
          id: "item:sub",
          type: "subagent",
          prompt: "",
          promptSequence: 6,
        }),
        row("old", "node.updated", { id: "node" }),
        row("legacy", "thread.created", { id: "legacy" }),
        row("legacy", "message.updated", { id: "message:1" }),
        row("legacy", "message.updated", { id: "message:2" }),
        row("project", "project.meta-updated", { projectId: "project" }, OLD, "project"),
        row("live", "thread.created", { id: "live" }),
        row("live", "node.updated", { id: "node" }),
        row("live", "node.updated", { id: "node" }, RECENT),
        row("live", "node.updated", { id: "node" }, RECENT),
      ])}`;
      yield* sql`
        INSERT INTO orchestration_v2_legacy_imports (
          thread_id, source_updated_at, shell_imported_at, imported_message_count
        ) VALUES ('legacy', ${OLD}, ${OLD}, 2)
      `;

      let floor = 0;
      const pass = EventLogRetention.retainRecentEvents({
        cutoffMillis: CUTOFF,
        floor: Effect.sync(() => floor),
        raiseFloor: (belowSequence) =>
          Effect.gen(function* () {
            // The floor rises before anything below it is deleted.
            expect(yield* remainingSequences).toHaveLength(16);
            floor = belowSequence;
          }),
        sweep: false,
      });
      const fiber = yield* Effect.forkChild(pass);
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(fiber)).toBe(5);

      expect(floor).toBe(15);
      expect(yield* remainingSequences).toEqual([1, 4, 6, 8, 9, 10, 11, 12, 13, 15, 16]);

      // Once the transcript import is done, its message events can go too,
      // and the sweep finds what an earlier pass had to leave.
      yield* sql`
        UPDATE orchestration_v2_legacy_imports SET transcript_imported_at = ${OLD}
        WHERE thread_id = 'legacy'
      `;
      const sweep = yield* Effect.forkChild(
        EventLogRetention.retainRecentEvents({
          cutoffMillis: CUTOFF,
          floor: Effect.sync(() => floor),
          raiseFloor: () => Effect.die(new Error("the floor is already at the first recent event")),
          sweep: true,
        }),
      );
      expect(yield* Fiber.join(sweep)).toBe(1);
      expect(yield* remainingSequences).toEqual([1, 4, 6, 8, 9, 11, 12, 13, 15, 16]);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

const layerEventStore = OrchestrationEventStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const subagentUpdate = (threadId: ThreadId, index: number, occurredAt: string) => {
  const at = DateTime.makeUnsafe(occurredAt);
  return {
    id: EventId.make(`event:${threadId}:${index}`),
    type: "turn-item.updated",
    threadId,
    occurredAt: at,
    payload: {
      id: TurnItemId.make(`item:${threadId}`),
      type: "subagent",
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running",
      title: "Audit",
      subagentId: NodeId.make(`node:${threadId}`),
      origin: "provider_native",
      driver: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      childThreadId: null,
      prompt: "The whole brief",
      progress: `Update ${index}`,
      result: null,
      startedAt: at,
      completedAt: null,
      updatedAt: at,
    },
  } satisfies OrchestrationV2DomainEvent;
};

it.effect("kept events still read back their subagent prompt, and appends continue", () =>
  Effect.gen(function* () {
    const store = yield* OrchestrationEventStore.OrchestrationEventStore;
    const sql = yield* SqlClient.SqlClient;
    // Every copy after the first stores the prompt as a pointer to the first.
    const finished = ThreadId.make("thread:finished");
    const ongoing = ThreadId.make("thread:ongoing");
    const stored = yield* store.appendAgentEvents({
      events: [
        subagentUpdate(finished, 1, OLD),
        subagentUpdate(finished, 2, OLD),
        subagentUpdate(finished, 3, OLD),
        subagentUpdate(ongoing, 1, OLD),
        subagentUpdate(ongoing, 2, OLD),
        subagentUpdate(ongoing, 3, RECENT),
      ],
    });
    const pointers = yield* sql<{ readonly prompt_sequence: number | null }>`
      SELECT json_extract(payload_json, '$.promptSequence') AS prompt_sequence
      FROM orchestration_events ORDER BY sequence
    `;
    expect(pointers.map((row) => row.prompt_sequence)).toEqual([null, 1, 1, null, 4, 4]);

    expect(yield* EventLogRetention.trimExpiredEvents({ fromSequence: 0, belowSequence: 6 })).toBe(
      2,
    );

    // The newest event of the finished thread points below the floor at its prompt.
    expect(yield* store.readAgentEvents({ threadId: finished }).pipe(Stream.runCollect)).toEqual([
      stored[0],
      stored[2],
    ]);
    expect(yield* store.readAgentEvents({ threadId: ongoing }).pipe(Stream.runCollect)).toEqual([
      stored[3],
      stored[5],
    ]);
    const [next] = yield* store.appendAgentEvents({
      events: [subagentUpdate(finished, 4, RECENT)],
    });
    expect(yield* store.latestAgentSequence(finished)).toBe(next!.sequence);
    const versions = yield* sql<{ readonly stream_version: number }>`
      SELECT stream_version FROM orchestration_events
      WHERE stream_id = ${finished} ORDER BY sequence
    `;
    expect(versions.map((row) => row.stream_version)).toEqual([0, 2, 3]);
  }).pipe(Effect.provide(layerEventStore)),
);
