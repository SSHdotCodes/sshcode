import * as NodeServices from "@effect/platform-node/NodeServices";
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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventLogCompaction from "./EventLogCompaction.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

describe("supersededTurnItemSequences", () => {
  it("keeps each item's first and last copy in the window and drops the rest", () => {
    expect(
      EventLogCompaction.supersededTurnItemSequences([
        { sequence: 10, item_id: "tool" },
        { sequence: 11, item_id: "reply" },
        { sequence: 12, item_id: "tool" },
        { sequence: 14, item_id: "tool" },
        { sequence: 13, item_id: "tool" },
        { sequence: 15, item_id: "reply" },
        { sequence: 16, item_id: "once" },
        { sequence: 17, item_id: null },
      ]),
    ).toEqual([12, 13]);
  });
});

it.effect("deletes only in-between turn item copies inside the window", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const row = (ordinal: number, eventType: string, payload: object) => ({
      event_id: `event:${ordinal}`,
      aggregate_kind: "thread",
      stream_id: "thread-1",
      stream_version: ordinal,
      event_type: eventType,
      occurred_at: "2026-10-28T00:00:00.000Z",
      actor_kind: "server",
      payload_json: encodeJson(payload),
      metadata_json: "{}",
      application_event_version: 2,
    });
    yield* sql`INSERT INTO orchestration_events ${sql.insert([
      row(1, "turn-item.updated", { id: "tool", output: "a" }),
      row(2, "turn-item.updated", { id: "tool", output: "ab" }),
      row(3, "node.updated", { id: "node" }),
      row(4, "turn-item.updated", { id: "tool", output: "abc" }),
      row(5, "turn-item.updated", { id: "tool", output: "abcd" }),
      // Outside the window: the item is still streaming.
      row(6, "turn-item.updated", { id: "tool", output: "abcde" }),
      row(7, "turn-item.updated", { id: "tool", output: "abcdef" }),
    ])}`;

    const deleted = yield* EventLogCompaction.compactTurnItemWindow({
      afterSequence: 0,
      throughSequence: 5,
    });

    const left = yield* sql<{ readonly sequence: number }>`
      SELECT sequence FROM orchestration_events ORDER BY sequence
    `;
    expect(deleted).toBe(2);
    expect(left.map((event) => event.sequence)).toEqual([1, 3, 5, 6, 7]);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

const layerEventStore = OrchestrationEventStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const layerCompaction = Layer.mergeAll(
  layerEventStore,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-event-compaction-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
);
const layerMaintenance = ProjectionMaintenance.layer.pipe(
  Layer.provide(Layer.merge(EventStore.layerFromOrchestrationEventStore, ProjectionStore.layer)),
  Layer.provideMerge(layerEventStore),
);

const subagentItem = (index: number, prompt: string) => {
  const now = DateTime.makeUnsafe("2026-10-28T00:00:00.000Z");
  const threadId = ThreadId.make("thread:compaction-prompt");
  return {
    id: EventId.make(`event:compaction-prompt:${index}`),
    type: "turn-item.updated",
    threadId,
    occurredAt: now,
    payload: {
      id: TurnItemId.make("item:compaction-prompt"),
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
      subagentId: NodeId.make("node:compaction-prompt"),
      origin: "provider_native",
      driver: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      childThreadId: null,
      prompt,
      progress: `Update ${index}`,
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    },
  } satisfies OrchestrationV2DomainEvent;
};

it.effect.each([3, 4])(
  "replays revised subagent prompts after window and full-store compaction through update %s",
  (throughSequence) =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore.OrchestrationEventStore;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const sql = yield* SqlClient.SqlClient;
      const events = [
        subagentItem(1, "Prompt A"),
        subagentItem(2, "Revised prompt B"),
        subagentItem(3, "Revised prompt B"),
        subagentItem(4, "Revised prompt B"),
        // References the revised anchor from outside the compaction window.
        subagentItem(5, "Revised prompt B"),
      ];
      const stored = yield* store.appendAgentEvents({ events });
      const references = yield* sql<{ readonly prompt_sequence: number | null }>`
        SELECT json_extract(payload_json, '$.promptSequence') AS prompt_sequence
        FROM orchestration_events ORDER BY sequence
      `;
      expect(references.map((row) => row.prompt_sequence)).toEqual([null, null, 2, 2, 2]);

      yield* EventLogCompaction.compactTurnItemWindow({ afterSequence: 0, throughSequence });
      yield* maintenance.compactEventStore;

      const expected = stored.filter((event) => throughSequence === 3 || event.sequence !== 3);
      expect(yield* store.readAgentEvents().pipe(Stream.runCollect)).toEqual(expected);
      expect(
        yield* store
          .readApplicationEvents({ afterSequence: 0, throughSequence: 5 })
          .pipe(Stream.runCollect),
      ).toEqual(expected);
    }).pipe(Effect.provide(layerMaintenance)),
);

const writeCursor = (cursor: { readonly through?: number; readonly retainedFrom?: number }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    yield* fs.makeDirectory(stateDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(stateDir, EventLogCompaction.CURSOR_FILE),
      JSON.stringify(cursor),
    );
  });

const readCursor = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  return JSON.parse(
    yield* fs.readFileString(path.join(stateDir, EventLogCompaction.CURSOR_FILE)),
  ) as unknown;
});

/** The cursor is written with real file I/O; read until it lands (bounded). */
// The compactor saves its cursor from a background fiber doing database work. Slow machines
// need real time for it, not just scheduler turns, so after a quick spin this waits up to ~5 s.
const awaitCursor = (through: number, retainedFrom = 0) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const cursor = yield* readCursor.pipe(Effect.orElseSucceed(() => null));
      if (JSON.stringify(cursor) === JSON.stringify({ through, retainedFrom, agedThrough: 0 })) {
        return cursor;
      }
      yield* attempt < 100 ? Effect.yieldNow : TestClock.withLive(Effect.sleep("10 millis"));
    }
    return yield* readCursor;
  });

it.effect("compacts an unfinished window after restarting the background compactor", () =>
  Effect.gen(function* () {
    const store = yield* OrchestrationEventStore.OrchestrationEventStore;
    const stored = yield* store.appendAgentEvents({
      events: [1, 2, 3, 4].map((index) => subagentItem(index, "Unchanged prompt")),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(EventLogCompaction.layer);
        yield* TestClock.adjust("1 minute");
      }),
    );
    expect(yield* store.readAgentEvents().pipe(Stream.runCollect)).toEqual(stored);

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(EventLogCompaction.layer);
        // Startup settles before old history is read.
        yield* TestClock.adjust("1 minute");
        expect(yield* store.readAgentEvents().pipe(Stream.runCollect)).toEqual(stored);
        yield* TestClock.adjust("2 minutes");
        expect(yield* store.readAgentEvents().pipe(Stream.runCollect)).toEqual([
          stored[0],
          stored[3],
        ]);
        expect(yield* awaitCursor(4)).toEqual({ through: 4, retainedFrom: 0, agedThrough: 0 });
      }),
    );
  }).pipe(Effect.provide(layerCompaction)),
);

it.effect("does not reread history the saved cursor already covers", () =>
  Effect.gen(function* () {
    const store = yield* OrchestrationEventStore.OrchestrationEventStore;
    const stored = yield* store.appendAgentEvents({
      events: [1, 2, 3, 4].map((index) => subagentItem(index, "Unchanged prompt")),
    });
    yield* writeCursor({ through: 4 });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(EventLogCompaction.layer);
        yield* TestClock.adjust("30 minutes");
      }),
    );
    expect(yield* store.readAgentEvents().pipe(Stream.runCollect)).toEqual(stored);
  }).pipe(Effect.provide(layerCompaction)),
);

it.effect("starts over when the saved cursor belongs to another database", () =>
  Effect.gen(function* () {
    const store = yield* OrchestrationEventStore.OrchestrationEventStore;
    const stored = yield* store.appendAgentEvents({
      events: [1, 2, 3, 4].map((index) => subagentItem(index, "Unchanged prompt")),
    });
    yield* writeCursor({ through: 999 });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(EventLogCompaction.layer);
        yield* TestClock.adjust("3 minutes");
        expect(yield* awaitCursor(4)).toEqual({ through: 4, retainedFrom: 0, agedThrough: 0 });
      }),
    );
    expect(yield* store.readAgentEvents().pipe(Stream.runCollect)).toEqual([stored[0], stored[3]]);
  }).pipe(Effect.provide(layerCompaction)),
);

it.effect("keeps the floor offline maintenance wrote, sweeps below it and compacts above it", () =>
  Effect.gen(function* () {
    const store = yield* OrchestrationEventStore.OrchestrationEventStore;
    const stored = yield* store.appendAgentEvents({
      events: [1, 2, 3, 4].map((index) => subagentItem(index, "Unchanged prompt")),
    });
    yield* writeCursor({ through: 0, retainedFrom: 3 });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(EventLogCompaction.layer);
        const canReplayAfter = (sequence: number) =>
          EventLogCompaction.canReplayAfter(sequence).pipe(Effect.provideContext(context));
        // Events 1 and 2 may be gone, so only a replay after 2 is complete.
        expect(yield* canReplayAfter(1)).toBe(false);
        expect(yield* canReplayAfter(2)).toBe(true);
        yield* TestClock.adjust("3 minutes");
        // Compaction saved its progress without losing the floor.
        expect(yield* awaitCursor(4, 3)).toEqual({ through: 4, retainedFrom: 3, agedThrough: 0 });
      }),
    );
    // Below the floor only the full prompt stays; the window after it holds
    // just the item's first and last copy there, so compaction keeps both.
    expect(yield* store.readAgentEvents().pipe(Stream.runCollect)).toEqual([
      stored[0],
      stored[2],
      stored[3],
    ]);
  }).pipe(Effect.provide(layerCompaction)),
);

it.effect("ignores a floor past the end, which belongs to another database", () =>
  Effect.gen(function* () {
    const store = yield* OrchestrationEventStore.OrchestrationEventStore;
    yield* store.appendAgentEvents({ events: [subagentItem(1, "Prompt")] });
    yield* writeCursor({ through: 0, retainedFrom: 999 });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(EventLogCompaction.layer);
        expect(
          yield* EventLogCompaction.canReplayAfter(0).pipe(Effect.provideContext(context)),
        ).toBe(true);
      }),
    );
  }).pipe(Effect.provide(layerCompaction)),
);

it("reads every cursor field and treats anything else as empty", () => {
  const empty = { through: 0, retainedFrom: 0, agedThrough: 0 };
  expect(EventLogCompaction.parseCursor('{"through":7,"retainedFrom":5,"agedThrough":3}')).toEqual({
    through: 7,
    retainedFrom: 5,
    agedThrough: 3,
  });
  // The offline slim may write only the floor.
  expect(EventLogCompaction.parseCursor('{"retainedFrom":5}')).toEqual({
    ...empty,
    retainedFrom: 5,
  });
  expect(EventLogCompaction.parseCursor("not json")).toEqual(empty);
  expect(EventLogCompaction.parseCursor('{"retainedFrom":-1}')).toEqual(empty);
});

it.effect("deletes expired events in the background, saving the floor first", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-20T00:00:00.000Z"));
    const store = yield* OrchestrationEventStore.OrchestrationEventStore;
    const recent = subagentItem(4, "Unchanged prompt");
    const stored = yield* store.appendAgentEvents({
      events: [
        ...[1, 2, 3].map((index) => subagentItem(index, "Unchanged prompt")),
        { ...recent, occurredAt: DateTime.makeUnsafe("2026-11-19T00:00:00.000Z") },
      ],
    });
    // Compaction has read everything; only retention has work.
    yield* writeCursor({ through: 4 });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(EventLogCompaction.layer);
        const canReplayAfter = (sequence: number) =>
          EventLogCompaction.canReplayAfter(sequence).pipe(Effect.provideContext(context));
        expect(yield* canReplayAfter(0)).toBe(true);
        yield* TestClock.adjust("2 minutes");
        expect(yield* awaitCursor(4, 4)).toEqual({ through: 4, retainedFrom: 4, agedThrough: 0 });
        expect(yield* canReplayAfter(2)).toBe(false);
        expect(yield* canReplayAfter(3)).toBe(true);
        let left = stored;
        for (let attempt = 0; attempt < 20 && left.length === stored.length; attempt += 1) {
          yield* TestClock.adjust("5 seconds");
          left = Array.from(yield* store.readAgentEvents().pipe(Stream.runCollect));
        }
        // The first copy holds the prompt the newest one points at.
        expect(left).toEqual([stored[0], stored[3]]);
      }),
    );
  }).pipe(Effect.provide(layerCompaction)),
);

it.effect("ages week-old tool outputs in the background and saves how far it got", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-20T00:00:00.000Z"));
    const sql = yield* SqlClient.SqlClient;
    const output = "x".repeat(10_000);
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert({
      turn_item_id: "item:old-command",
      thread_id: "thread:aging",
      ordinal: 1,
      type: "command_execution",
      status: "completed",
      updated_at: "2026-11-01T00:00:00.000Z",
      payload_json: encodeJson({ id: "item:old-command", type: "command_execution", output }),
    })}`;
    const storedLength = sql<{ readonly length: number }>`
      SELECT length(payload_json) AS length FROM orchestration_v2_projection_turn_items
    `.pipe(Effect.map((rows) => rows[0]?.length ?? 0));
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(EventLogCompaction.layer);
        yield* TestClock.adjust("4 minutes");
        expect(yield* storedLength).toBeGreaterThan(10_000);
        yield* TestClock.adjust("1 minute");
        let cursor: unknown = null;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          cursor = yield* readCursor.pipe(Effect.orElseSucceed(() => null));
          if ((cursor as { agedThrough?: number } | null)?.agedThrough === 1) break;
          yield* Effect.yieldNow;
        }
        expect(cursor).toMatchObject({ agedThrough: 1 });
        expect(yield* storedLength).toBeLessThan(2_200);
      }),
    );
  }).pipe(Effect.provide(layerCompaction)),
);
