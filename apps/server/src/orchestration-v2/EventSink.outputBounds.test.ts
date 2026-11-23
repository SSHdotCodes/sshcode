import { assert, it } from "@effect/vitest";
import {
  EventId,
  type OrchestrationV2AppThread,
  type OrchestrationV2TurnItem,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { toolOutputImages } from "@t3tools/shared/toolOutput";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerStores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const layerTest = Layer.mergeAll(
  EventSink.layer.pipe(Layer.provide(layerStores)),
  layerStores,
  IdAllocator.layer,
);

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const MAX_STORED_TEXT_BYTES = 256 * 1024;

it.effect("every writer's long outputs are bounded in the event log and the projection", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:output-bounds");
    const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: yield* idAllocator.allocate.project({ fixtureName: "output-bounds" }),
      title: "Output bounds",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      branchPullRequest: null,
      activeOrderKey: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const itemBase = {
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      title: null,
      status: "completed",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    } as const;
    const screenshot = Buffer.alloc(450_000, 3).toString("base64");
    const command: OrchestrationV2TurnItem = {
      ...itemBase,
      id: TurnItemId.make("turn-item:long-command"),
      ordinal: 1,
      type: "command_execution",
      input: "cat build.log",
      output: `start\n${"log line\n".repeat(200_000)}end`,
    };
    const tool: OrchestrationV2TurnItem = {
      ...itemBase,
      id: TurnItemId.make("turn-item:computer-use"),
      ordinal: 2,
      type: "dynamic_tool",
      toolName: "computer-use.get_app_state",
      input: {},
      output: [
        { type: "text", text: `tree ${"node ".repeat(200_000)}` },
        { type: "image", data: screenshot, mimeType: "image/png" },
      ],
    };
    // Written straight to the sink, as the importer and server-side writers do.
    yield* eventSink.write({
      events: [
        {
          id: yield* idAllocator.allocate.event({ threadId }),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: thread,
        },
        ...[command, tool].map((payload) => ({
          id: EventId.make(`event:${payload.id}`),
          type: "turn-item.updated" as const,
          threadId,
          occurredAt: now,
          payload,
        })),
      ],
    });

    const storedCommand = yield* projections.getTurnItem({ threadId, itemId: command.id });
    const commandOutput = storedCommand?.type === "command_execution" ? storedCommand.output : "";
    assert.isAtMost(Buffer.byteLength(commandOutput ?? "", "utf8"), MAX_STORED_TEXT_BYTES);
    assert.isTrue(commandOutput?.startsWith("start\n"));
    assert.isTrue(commandOutput?.endsWith("log line\nend"));
    assert.include(commandOutput, "characters of output omitted");

    const storedTool = yield* projections.getTurnItem({ threadId, itemId: tool.id });
    const toolOutput = storedTool?.type === "dynamic_tool" ? storedTool.output : undefined;
    const [text] = toolOutput as ReadonlyArray<{ readonly text: string }>;
    assert.isAtMost(Buffer.byteLength(text?.text ?? "", "utf8"), MAX_STORED_TEXT_BYTES);
    assert.isTrue(text?.text.startsWith("tree node"));
    assert.strictEqual(toolOutputImages(toolOutput)[0]?.data, screenshot);

    // The event payload is bounded the same way, so replays match the projection.
    const rows = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM orchestration_events
      WHERE event_type = 'turn-item.updated' ORDER BY sequence
    `;
    const [commandEvent, toolEvent] = rows.map(
      (row) => decodeJson(row.payload_json) as { readonly output: unknown },
    );
    assert.strictEqual(commandEvent?.output, commandOutput);
    assert.deepStrictEqual(toolEvent?.output, toolOutput);
  }).pipe(Effect.provide(layerTest)),
);
