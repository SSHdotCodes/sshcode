import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { createdChatFailureCommand, isFirstCreatedChatFailure } from "./createdChatFailure.ts";

const instanceId = ProviderInstanceId.make("codex");
const selection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const layer = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  EffectOutbox.layer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "created-chat-notices" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

it("only a real first-run failure can notify the creator", () => {
  const id = RunId.make("first");
  const receipt = {
    creatorThreadId: ThreadId.make("creator"),
    firstRunId: id,
    startup: "started" as const,
  };
  assert.isTrue(isFirstCreatedChatFailure({ id, ordinal: 1, status: "failed" }, receipt));
  assert.isFalse(isFirstCreatedChatFailure({ id, ordinal: 2, status: "failed" }, receipt));
  assert.isFalse(isFirstCreatedChatFailure({ id, ordinal: 1, status: "completed" }, receipt));
  assert.isFalse(isFirstCreatedChatFailure({ id, ordinal: 1, status: "cancelled" }, receipt));
  assert.isFalse(isFirstCreatedChatFailure({ id, ordinal: 1, status: "interrupted" }, receipt));
  assert.isFalse(
    isFirstCreatedChatFailure(
      { id, ordinal: 1, status: "failed" },
      { ...receipt, startup: "failed" },
    ),
  );
  assert.isFalse(
    isFirstCreatedChatFailure(
      { id, ordinal: 1, status: "failed" },
      { ...receipt, failureNoticeQueued: true },
    ),
  );
});

it.live(
  "queues a late first-run failure behind the creator's active run exactly once",
  () =>
    Effect.gen(function* () {
      const engine = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const creator = ThreadId.make("thread:creator");
      const child = ThreadId.make("thread:independent");
      for (const threadId of [creator, child]) {
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${threadId}`),
          threadId,
          projectId: ProjectId.make("project:created"),
          title: threadId === child ? "Black hole simulation" : "Benchmark",
          modelSelection: selection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: threadId === child ? "agent" : "user",
          creationSource: threadId === child ? "mcp" : "web",
        });
        yield* engine.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`start:${threadId}`),
          threadId,
          messageId: MessageId.make(`message:${threadId}`),
          text: "Start",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: threadId === child ? "agent" : "user",
          creationSource: threadId === child ? "mcp" : "web",
        });
      }
      const parentRun = (yield* projections.getThreadRecords(creator, ["runs"])).runs[0]!;
      const childRun = (yield* projections.getThreadRecords(child, ["runs"])).runs[0]!;
      yield* engine.dispatch({
        type: "thread.created.record",
        commandId: CommandId.make("record:created"),
        parentThreadId: creator,
        parentRunId: parentRun.id,
        parentNodeId: parentRun.rootNodeId!,
        targetThreadId: child,
        targetRunId: childRun.id,
      });
      yield* engine.dispatch({
        type: "thread.created.report",
        commandId: CommandId.make("report:created"),
        threadId: child,
        startup: "started",
      });
      const afterSequence = yield* engine.getThreadEventSequence(child);
      const now = yield* DateTime.now;
      const failure = "Budget exhausted. Add credits or raise the spending limit.";
      yield* sink.write({
        events: [
          {
            id: EventId.make("created:preview"),
            type: "message.updated",
            threadId: child,
            runId: childRun.id,
            occurredAt: now,
            payload: {
              id: MessageId.make("created:preview"),
              threadId: child,
              runId: childRun.id,
              nodeId: childRun.rootNodeId,
              role: "assistant",
              text: "Starting the simulation. ".repeat(30),
              attachments: [],
              streaming: false,
              createdAt: now,
              updatedAt: now,
              createdBy: "agent",
              creationSource: "provider",
            },
          },
          {
            id: EventId.make("created:error"),
            type: "turn-item.updated",
            threadId: child,
            runId: childRun.id,
            occurredAt: now,
            payload: {
              id: TurnItemId.make("created:error"),
              threadId: child,
              runId: childRun.id,
              nodeId: childRun.rootNodeId!,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 2,
              status: "failed",
              title: "Provider error",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "error",
              failure: { class: "billing_error", message: failure, code: null, retryable: false },
            },
          },
          {
            id: EventId.make("created:failed"),
            type: "run.updated",
            threadId: child,
            runId: childRun.id,
            occurredAt: now,
            payload: { ...childRun, status: "failed", completedAt: now },
          },
        ] satisfies OrchestrationV2DomainEvent[],
      });
      yield* engine
        .streamStoredEventsFrom({
          threadId: child,
          afterSequence,
          eventType: "thread.metadata-updated",
        })
        .pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "thread.metadata-updated" &&
              event.payload.createdChat?.failureNoticeQueued === true,
          ),
          Stream.take(1),
          Stream.runDrain,
        );
      assert.equal(
        (yield* engine.getThreadShell(child))?.createdChatPreview,
        "Starting the simulation. ".repeat(30).slice(0, 280),
      );
      const effect = Option.getOrThrow(yield* outbox.get(`effect:created-chat-failure:${child}`));
      assert.isDefined(effect);
      assert.equal(effect.request.type, "created-chat.failure");
      if (effect.request.type !== "created-chat.failure") return;
      assert.equal(effect.request.error, failure);
      const command = createdChatFailureCommand(child, effect.request);
      yield* engine.dispatch(command);
      yield* engine.dispatch(command);
      const parent = yield* projections.getThreadRecords(creator, ["runs", "messages"]);
      const notices = parent.messages.filter((message) => message.notification !== undefined);
      assert.equal(notices.length, 1);
      assert.equal(
        notices[0]!.text,
        `The chat you created, "Black hole simulation", failed: ${failure}`,
      );
      assert.equal(
        parent.runs.find((run) => run.userMessageId === notices[0]!.id)?.status,
        "queued",
      );
      assert.equal(parent.runs.find((run) => run.id === parentRun.id)?.status, "starting");
      assert.equal((yield* projections.getThread(child)).lineage.parentThreadId, null);
    }).pipe(Effect.provide(layer)),
  60_000,
);
