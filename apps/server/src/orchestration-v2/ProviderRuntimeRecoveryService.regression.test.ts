import {
  ProviderInstanceId,
  MessageId,
  NodeId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import { expect, it } from "vite-plus/test";

import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ServerSettings from "../serverSettings.ts";

it("uses the thread provider for stale background work without provider threads", async () => {
  const threadId = ThreadId.make("thread_recovery_background_no_provider_threads");
  const runId = RunId.make("run_recovery_background_no_provider_threads");
  const itemId = TurnItemId.make("turn_item_recovery_background_no_provider_threads");
  const providerInstanceId = ProviderInstanceId.make("codex");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const projection = {
    thread: { id: threadId, providerInstanceId, archivedAt: null, deletedAt: null },
    runtimeRequests: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runs: [{ id: runId, status: "completed", providerInstanceId }],
    attempts: [],
    nodes: [],
    subagents: [],
    messages: [],
    turnItems: [
      {
        id: itemId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        type: "command_execution",
        status: "running",
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([threadId]),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) => {
            committedInput = input;
            return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
          },
        }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );

  await Effect.gen(function* () {
    yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
    const event = committedInput?.events.find(
      (candidate) => candidate.type === "turn-item.updated",
    );
    expect(event?.providerInstanceId).toBe(providerInstanceId);
    expect(event?.type === "turn-item.updated" ? event.payload.status : null).toBe("cancelled");
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("recovers a running run and lost command even when its Claude session already stopped", async () => {
  const threadId = ThreadId.make("thread:orphaned-claude");
  const providerInstanceId = ProviderInstanceId.make("claudeAgent");
  const providerThreadId = ProviderThreadId.make("provider-thread:orphaned");
  const sessionId = ProviderSessionId.make("session:already-stopped");
  const turnId = ProviderTurnId.make("turn:orphaned");
  const runId = RunId.make("run:orphaned");
  const attemptId = RunAttemptId.make("attempt:orphaned");
  const nodeId = NodeId.make("node:orphaned");
  const queuedId = RunId.make("run:queued-follow-up");
  const messageId = MessageId.make("message:queued-follow-up");
  const now = DateTime.makeUnsafe("2026-11-10T04:36:15Z");
  const projection = {
    thread: { id: threadId, providerInstanceId, archivedAt: null, deletedAt: null },
    runtimeRequests: [],
    providerSessions: [{ id: sessionId, status: "stopped" }],
    providerThreads: [
      { id: providerThreadId, providerSessionId: sessionId, status: "active", ownerNodeId: null },
    ],
    providerTurns: [{ id: turnId, providerThreadId, runAttemptId: attemptId, status: "running" }],
    runs: [
      {
        id: runId,
        ordinal: 2,
        status: "running",
        activeAttemptId: attemptId,
        providerThreadId,
        providerInstanceId,
      },
      { id: queuedId, ordinal: 3, status: "queued", userMessageId: messageId, providerInstanceId },
    ],
    attempts: [{ id: attemptId, runId, rootNodeId: nodeId, status: "running" }],
    nodes: [{ id: nodeId, runId, status: "running" }],
    subagents: [],
    messages: [],
    turnItems: [
      {
        id: TurnItemId.make("item:lost-verification"),
        runId,
        nodeId,
        providerThreadId,
        type: "command_execution",
        status: "running",
        output: "Partial verification output",
        startedAt: now,
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const commits: Array<Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]> = [];
  const targets: Array<
    Parameters<EffectOutbox.EffectOutboxV2["Service"]["requeueFailedSteers"]>[0]
  > = [];
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true })),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([threadId]),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          getThreadRecords: () =>
            Effect.succeed({
              messages: [
                {
                  id: messageId,
                  createdBy: "agent",
                  creationSource: "mcp",
                  senderThreadId: ThreadId.make("parent"),
                },
              ],
            } as unknown as OrchestrationV2ThreadProjection),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) => {
            commits.push(input);
            return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
          },
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          requeueFailedSteers: (input) =>
            Effect.sync(() => {
              targets.push(input);
              return 1;
            }),
        }),
        IdAllocator.layer,
      ),
    ),
  );
  await Effect.gen(function* () {
    const summary = yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).recover;
    expect(summary.terminalizedRuns).toBe(1);
    expect(summary.requeuedEffects).toBe(1);
    const commit = commits[0]!;
    for (const type of [
      "run.updated",
      "run-attempt.updated",
      "provider-turn.updated",
      "node.updated",
    ] as const) {
      expect(commit.events.find((event) => event.type === type)?.payload).toMatchObject({
        status: "cancelled",
      });
    }
    const command = commit.events.find((event) => event.type === "turn-item.updated");
    expect(command?.payload).toMatchObject({
      status: "cancelled",
      output:
        "Partial verification output\n\nThe command's result was lost when the provider process ended.",
    });
    expect(
      commit.events.some((event) => event.type === "run.updated" && event.runId === queuedId),
    ).toBe(false);
    expect(commit.effects).toEqual([]);
    expect(targets).toEqual([{ threadId, providerTurnIds: [turnId] }]);
  }).pipe(Effect.provide(layer), Effect.runPromise);
});
