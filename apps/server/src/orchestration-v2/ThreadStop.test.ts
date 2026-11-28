import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as MonitorService from "../monitors/MonitorService.ts";
import * as ServerConfig from "../config.ts";
import * as ExecutionResources from "../execution/ExecutionResources.ts";
import * as Context from "effect/Context";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as EventStore from "./EventStore.ts";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CLAUDE_PROVIDER } from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import { OrchestrationEffectRequestV2 } from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
// No effect worker: runs stay unstarted, so Stop ends them without a provider.
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "thread-stop" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ExecutionResources.layer),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

const encodeEffectRequest = Schema.encodeSync(Schema.fromJsonString(OrchestrationEffectRequestV2));

const pullRequest = (number: number) => ({
  host: "github.com",
  repository: "pingdotgg/t3code",
  number,
});

const createWatchingThread = (threadId: ThreadId, number: number) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:thread-stop"),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* watch(threadId, number);
  });

const watch = (threadId: ThreadId, number: number) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make(`watch:${threadId}:${number}`),
      threadId,
      ...pullRequest(number),
      watching: true,
      link: { url: `https://github.com/pingdotgg/t3code/pull/${number}`, source: "agent" },
    });
  });

const send = (threadId: ThreadId, text: string, type: "start_immediately" | "queue_after_active") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type },
      createdBy: "user",
      creationSource: "web",
    });
  });

it.effect("storage cancellation keeps the queued message visible and does not deliver it", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:storage-cancel");
    yield* createWatchingThread(threadId, 91);
    yield* send(threadId, "active", "start_immediately");
    yield* send(threadId, "keep queued text", "queue_after_active");
    const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
      (run) => run.status === "queued",
    )!;
    yield* orchestrator.dispatch({
      type: "queued-run.cancel",
      retainMessage: true,
      commandId: CommandId.make("storage-cancel"),
      threadId,
      runId: queued.id,
    });
    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(projection.runs.find((run) => run.id === queued.id)?.status, "cancelled");
    assert.isTrue(projection.runs.find((run) => run.id === queued.id)?.retainQueuedMessage);
    assert.equal(
      projection.messages.find((message) => message.id === queued.userMessageId)?.text,
      "keep queued text",
    );
    assert.isTrue(
      projection.visibleTurnItems.some(
        (row) => row.item.type === "user_message" && row.item.runId === queued.id,
      ),
    );
    const snapshot = yield* orchestrator.getThreadSnapshot(threadId);
    assert.isTrue(
      snapshot.projection.visibleTurnItems.some(
        (row) => row.item.type === "user_message" && row.item.runId === queued.id,
      ),
    );
    assert.equal(yield* orchestrator.resumeQueuedRuns, 0);
  }).pipe(Effect.provide(layerTest)),
);

/** Delegates `task` from the parent's latest run and returns the child thread. */
const delegate = (parentThreadId: ThreadId, task: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate:${task}`),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const projection = yield* orchestrator.getThreadProjection(parentThreadId);
    return projection.subagents.find((candidate) => candidate.prompt === task)!.childThreadId!;
  });

const threadState = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return {
      runs: projection.runs.map((run) => `${run.status}${run.queueHeld === true ? ":held" : ""}`),
      watched: (projection.thread.pullRequests ?? [])
        .filter((link) => link.watch !== undefined)
        .map((link) => link.number),
    };
  });

it.effect.each(["run.interrupt", "thread.stop"] as const)(
  "%s Stop ends watches, holds queues, and stops the delegated tasks under the thread",
  (type) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const sql = yield* SqlClient.SqlClient;
      const parentThreadId = ThreadId.make("thread:stop-parent");
      yield* createWatchingThread(parentThreadId, 1);
      yield* send(parentThreadId, "first", "start_immediately");
      const childThreadId = yield* delegate(parentThreadId, "child task");
      assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(childThreadId, 2))));
      const grandchildThreadId = yield* delegate(childThreadId, "grandchild task");
      yield* send(childThreadId, "child follow-up", "queue_after_active");

      const now = yield* DateTime.now;
      const firstRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
      yield* projections.apply({
        id: EventId.make("event:stop-parent:first-run-completed"),
        type: "run.updated",
        threadId: parentThreadId,
        runId: firstRun.id,
        occurredAt: now,
        payload: { ...firstRun, status: "completed", completedAt: now },
      });
      yield* send(parentThreadId, "second", "start_immediately");
      const secondRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;

      const stopCommandId = CommandId.make("stop-parent");
      yield* orchestrator.dispatch(
        type === "thread.stop"
          ? { type, commandId: stopCommandId, threadId: parentThreadId }
          : {
              type,
              commandId: stopCommandId,
              threadId: parentThreadId,
              runId: secondRun.id,
              holdQueue: true,
            },
      );

      assert.deepEqual(yield* threadState(parentThreadId), {
        runs: ["completed", "interrupted"],
        watched: [],
      });
      const parent = yield* orchestrator.getThreadProjection(parentThreadId);
      assert.equal(parent.subagents[0]?.completionDelivery?.state, "disposed");
      const effects = yield* sql<{ readonly effect_type: string }>`
      SELECT effect_type FROM orchestration_v2_effect_outbox WHERE command_id = ${stopCommandId}
    `;
      assert.include(
        effects.map((row) => row.effect_type),
        "delegated-tasks.stop",
      );

      yield* threads.stopDelegatedTasks({ threadId: parentThreadId, commandId: stopCommandId });
      assert.deepEqual(yield* threadState(childThreadId), {
        runs: ["interrupted", "queued:held"],
        watched: [],
      });
      assert.deepEqual((yield* threadState(grandchildThreadId)).runs, ["interrupted"]);

      yield* threads.stopDelegatedTasks({ threadId: parentThreadId, commandId: stopCommandId });
      assert.deepEqual((yield* threadState(childThreadId)).runs, ["interrupted", "queued:held"]);
      // The walk stops each level itself, so the child stops it sends queue no walk of their own.
      const walks = yield* sql<{ readonly command_id: string }>`
      SELECT command_id FROM orchestration_v2_effect_outbox
      WHERE effect_type = 'delegated-tasks.stop'
    `;
      assert.deepEqual(
        walks.map((row) => row.command_id),
        [stopCommandId],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "Stop reply preserves children, their completion wakes, watches, and queued messages",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sql = yield* SqlClient.SqlClient;
      const parentThreadId = ThreadId.make("thread:stop-reply");
      yield* createWatchingThread(parentThreadId, 1);
      yield* send(parentThreadId, "active", "start_immediately");
      const childThreadId = yield* delegate(parentThreadId, "child keeps working");
      const grandchildThreadId = yield* delegate(childThreadId, "grandchild keeps working");
      const before = yield* orchestrator.getThreadProjection(parentThreadId);
      yield* send(parentThreadId, "queued follow-up", "queue_after_active");
      const commandId = CommandId.make("stop-reply");
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId,
        threadId: parentThreadId,
        runId: before.runs[0]!.id,
        keepHelpers: true,
        // The scoped flag takes precedence even if an older caller also holds the queue.
        holdQueue: true,
      });
      const after = yield* orchestrator.getThreadProjection(parentThreadId);
      assert.equal(after.runs[0]?.status, "interrupted");
      assert.deepEqual(after.runs[0]?.delegatedCompletion, before.runs[0]?.delegatedCompletion);
      assert.deepEqual(after.subagents, before.subagents);
      assert.isFalse(after.runs[1]?.queueHeld === true);
      assert.notEqual(after.runs[1]?.status, "cancelled");
      assert.deepEqual((yield* threadState(parentThreadId)).watched, [1]);
      assert.deepEqual((yield* threadState(childThreadId)).runs, ["starting"]);
      assert.deepEqual((yield* threadState(grandchildThreadId)).runs, ["starting"]);
      const stops = yield* sql`
      SELECT effect_type FROM orchestration_v2_effect_outbox
      WHERE command_id = ${commandId} AND effect_type = 'delegated-tasks.stop'
    `;
      assert.deepEqual(stops, []);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a child completing after Stop reply still offers its parent a wake", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const parentThreadId = ThreadId.make("thread:stop-reply-wake");
    yield* createWatchingThread(parentThreadId, 1);
    yield* send(parentThreadId, "active", "start_immediately");
    const childThreadId = yield* delegate(parentThreadId, "finishing child");
    const before = yield* orchestrator.getThreadProjection(parentThreadId);
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("stop-reply-wake"),
      threadId: parentThreadId,
      runId: before.runs[0]!.id,
      keepHelpers: true,
    });
    const child = yield* orchestrator.getThreadProjection(childThreadId);
    const run = child.runs[0]!;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make("event:stop-reply-wake:completed"),
      type: "run.updated",
      threadId: childThreadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "completed", completedAt: now },
    });
    yield* orchestrator.recoverDelegatedTasks;
    const finished = yield* orchestrator.getThreadProjection(parentThreadId);
    assert.equal(finished.subagents[0]?.status, "completed");
    assert.equal(finished.subagents[0]?.completionDelivery?.state, "claimed");
    assert.equal(finished.runs[0]?.delegatedCompletion?.disposition, "open");
    assert.deepEqual(finished.runs[0]?.delegatedCompletion?.delivery?.taskIds, [
      before.subagents[0]!.id,
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("resuming a subagent after the parent's Stop wakes the parent when it finishes", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const parentThreadId = ThreadId.make("thread:stop-resume-parent");
    yield* createWatchingThread(parentThreadId, 3);
    yield* send(parentThreadId, "first", "start_immediately");
    const childThreadId = yield* delegate(parentThreadId, "resumed child task");
    const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
    const stopCommandId = CommandId.make("stop-resume-parent");
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: stopCommandId,
      threadId: parentThreadId,
      runId: parentRun.id,
      holdQueue: true,
    });
    yield* threads.stopDelegatedTasks({ threadId: parentThreadId, commandId: stopCommandId });
    yield* orchestrator.recoverDelegatedTasks;
    const interrupted = (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]!;
    assert.equal(interrupted.status, "interrupted");
    const originalTask = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
    assert.equal(originalTask.status, "interrupted");
    assert.equal(originalTask.completionDelivery?.state, "disposed");

    const resumeMessageId = MessageId.make("message:stop-resume-child:resume");
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("resume:stop-resume-child"),
      threadId: childThreadId,
      messageId: resumeMessageId,
      text: "",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      manualContinuationOfRunId: interrupted.id,
      createdBy: "user",
      creationSource: "web",
    });
    const resumed = (yield* orchestrator.getThreadProjection(childThreadId)).runs.find(
      (run) => run.userMessageId === resumeMessageId,
    )!;
    assert.isDefined(resumed.delegatedTaskId);

    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make("event:stop-resume-child:answer"),
      type: "message.updated",
      threadId: childThreadId,
      runId: resumed.id,
      occurredAt: now,
      payload: {
        id: MessageId.make("message:stop-resume-child:answer"),
        threadId: childThreadId,
        runId: resumed.id,
        nodeId: null,
        role: "assistant",
        text: "CHILD_DONE",
        attachments: [],
        streaming: false,
        createdBy: "agent",
        creationSource: "server",
        createdAt: now,
        updatedAt: now,
      },
    });
    yield* projections.apply({
      id: EventId.make("event:stop-resume-child:completed"),
      type: "run.updated",
      threadId: childThreadId,
      runId: resumed.id,
      occurredAt: now,
      payload: { ...resumed, status: "completed", startedAt: now, completedAt: now },
    });
    yield* orchestrator.recoverDelegatedTasks;

    const parent = yield* orchestrator.getThreadProjection(parentThreadId);
    const followup = parent.subagents.find((task) => task.id === resumed.delegatedTaskId);
    assert.equal(followup?.status, "completed");
    assert.equal(followup?.completionDelivery?.state, "claimed");
    assert.deepEqual(
      parent.runs.find((run) => run.id === parentRun.id)?.delegatedCompletion?.delivery?.taskIds,
      [followup!.id],
    );
    assert.equal(
      parent.subagents.find((task) => task.id === originalTask.id)?.completionDelivery?.state,
      "disposed",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a repeated Stop that changes nothing still stops the delegated tasks", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const parentThreadId = ThreadId.make("thread:stop-again");
    yield* createWatchingThread(parentThreadId, 1);
    yield* send(parentThreadId, "first", "start_immediately");
    yield* delegate(parentThreadId, "stop-again child");
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
    yield* projections.apply({
      id: EventId.make("event:stop-again:run-completed"),
      type: "run.updated",
      threadId: parentThreadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "completed", completedAt: now },
    });
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-again:first"),
      threadId: parentThreadId,
    });

    // The first Stop already disposed the delivery and ended the watch, so this one writes no
    // events, like Stop on a thread an older server stopped without stopping its children.
    const again = yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-again:second"),
      threadId: parentThreadId,
    });
    assert.lengthOf(again.storedEvents, 0);
    const walks = yield* sql<{ readonly command_id: string }>`
      SELECT command_id FROM orchestration_v2_effect_outbox
      WHERE effect_type = 'delegated-tasks.stop'
    `;
    assert.deepEqual(
      walks.map((row) => row.command_id),
      ["stop-again:first", "stop-again:second"],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["thread.stop", "run.interrupt"] as const)(
  "%s cancels buffered wakes and preserves durable queued messages",
  (type) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make(`thread:stop-buffered:${type}`);
      yield* createWatchingThread(threadId, 5);
      yield* send(threadId, "active", "start_immediately");
      yield* send(threadId, "user follow-up", "queue_after_active");
      for (const creationSource of ["provider", "server"] as const) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`notification:${type}:${creationSource}`),
          threadId,
          messageId: MessageId.make(`notification:${type}:${creationSource}`),
          text: "Background activity updated",
          attachments: [],
          createdBy: "agent",
          creationSource,
          notification: {
            source: { kind: "background_task" },
            outcome: "updated",
            summary: "Background activity updated",
          },
          dispatchMode: { type: "queue_after_active" },
        });
      }
      const before = yield* orchestrator.getThreadProjection(threadId);
      const buffered = before.runs.find((run) =>
        before.messages.some(
          (message) => message.id === run.userMessageId && message.creationSource === "provider",
        ),
      )!;
      const stop = { commandId: CommandId.make(`stop:${type}`), threadId };
      yield* orchestrator.dispatch(
        type === "run.interrupt"
          ? { ...stop, type, runId: before.runs[0]!.id, holdQueue: true }
          : { ...stop, type },
      );
      const stopped = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(stopped.runs.find((run) => run.id === buffered.id)?.status, "cancelled");
      assert.equal(
        stopped.attempts.find((attempt) => attempt.runId === buffered.id)?.status,
        "cancelled",
      );
      assert.equal(
        stopped.nodes.find((node) => node.id === buffered.rootNodeId)?.status,
        "cancelled",
      );
      assert.deepEqual(
        stopped.runs.filter((run) => run.status === "queued").map((run) => run.queueHeld),
        [true, true],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a message the user sends after Stop releases the held queue; an agent's does not", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:stop-release");
    const agentSend = (text: string) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`agent-send:${text}`),
        threadId,
        messageId: MessageId.make(`message:${threadId}:${text}`),
        text,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "mcp",
      });
    yield* createWatchingThread(threadId, 6);
    yield* send(threadId, "active", "start_immediately");
    yield* send(threadId, "queued before the stop", "queue_after_active");
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-release"),
      threadId,
    });
    assert.deepEqual((yield* threadState(threadId)).runs, ["interrupted", "queued:held"]);

    // An agent's message starts on the idle thread, but the hold is the user's.
    yield* agentSend("agent nudge");
    assert.deepEqual((yield* threadState(threadId)).runs, [
      "interrupted",
      "queued:held",
      "starting",
    ]);
    const nudge = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make("event:stop-release:nudge-completed"),
      type: "run.updated",
      threadId,
      runId: nudge.id,
      occurredAt: now,
      payload: { ...nudge, status: "completed", completedAt: now },
    });

    // A scheduled task the user created is not the user coming back.
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("scheduled-send"),
      threadId,
      messageId: MessageId.make(`message:${threadId}:scheduled`),
      text: "Nightly check",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
      scheduledTaskId: ScheduledTaskId.make("scheduled:nightly"),
    });
    const scheduled = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
    assert.deepEqual((yield* threadState(threadId)).runs, [
      "interrupted",
      "queued:held",
      "completed",
      "starting",
    ]);
    yield* projections.apply({
      id: EventId.make("event:stop-release:scheduled-completed"),
      type: "run.updated",
      threadId,
      runId: scheduled.id,
      occurredAt: now,
      payload: { ...scheduled, status: "completed", completedAt: now },
    });

    // The user is back: the held message follows their run, and a wake that
    // queues behind it is not held by the old Stop.
    yield* send(threadId, "back", "start_immediately");
    yield* agentSend("task finished");
    assert.deepEqual((yield* threadState(threadId)).runs, [
      "interrupted",
      "queued",
      "completed",
      "completed",
      "starting",
      "queued",
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "thread.stop ends an idle thread's watches and accepts a thread with nothing to stop",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:stop-idle");
      yield* createWatchingThread(threadId, 3);

      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-idle"),
        threadId,
      });
      assert.deepEqual(yield* threadState(threadId), { runs: [], watched: [] });

      const again = yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-idle-again"),
        threadId,
      });
      assert.lengthOf(again.storedEvents, 0);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a run Stop reached cannot delegate or start a watch, even after it ends", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:stop-barrier");
    yield* createWatchingThread(threadId, 4);
    yield* send(threadId, "work", "start_immediately");
    const now = yield* DateTime.now;
    const run = { ...(yield* orchestrator.getThreadProjection(threadId)).runs[0]!, startedAt: now };
    yield* projections.apply({
      id: EventId.make("event:stop-barrier:running"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "running" },
    });
    // A queued message the user cancelled does not count as the latest run.
    yield* send(threadId, "queued", "queue_after_active");
    const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "queued-run.cancel",
      commandId: CommandId.make("cancel-queued"),
      threadId,
      runId: queued.id,
    });
    // Stop reached the run, but its provider has not stopped it yet.
    yield* projections.apply({
      id: EventId.make("event:stop-barrier:interrupt-request"),
      type: "turn-item.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("turn-item:stop-barrier:interrupt-request"),
        threadId,
        runId: run.id,
        nodeId: run.rootNodeId!,
        providerThreadId: run.providerThreadId!,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1_000,
        status: "completed",
        title: "Interrupt requested",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "run_interrupt_request",
        message: "Stop",
      },
    });

    assert.isTrue(Exit.isFailure(yield* Effect.exit(delegate(threadId, "late task"))));
    assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(threadId, 5))));

    // A slow watch_pull_request call can land after the stopped run ended.
    yield* projections.apply({
      id: EventId.make("event:stop-barrier:interrupted"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "interrupted", completedAt: now },
    });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(threadId, 5))));
    assert.deepEqual(yield* threadState(threadId), {
      runs: ["interrupted", "cancelled"],
      watched: [4],
    });

    // The user can still stop and restart a watch by hand.
    for (const watching of [false, true]) {
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make(`manual-watch:${watching}`),
        threadId,
        ...pullRequest(4),
        watching,
      });
    }
    assert.deepEqual((yield* threadState(threadId)).watched, [4]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("thread.stop keeps a restart continuation of the stopped run from starting", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:stop-restart");
    yield* createWatchingThread(threadId, 8);
    yield* send(threadId, "work", "start_immediately");
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    // A server restart cut the run before its provider started; its continuation is pending.
    yield* projections.apply({
      id: EventId.make("event:stop-restart:cancelled"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "cancelled", startedAt: null, completedAt: now },
    });
    const at = DateTime.formatIso(now);
    yield* sql`
      INSERT INTO orchestration_v2_effect_outbox (
        effect_id, command_id, thread_id, effect_type, payload_json, status,
        attempt_count, available_at, created_at, updated_at
      ) VALUES (
        ${`effect:restart-continuation:${run.id}`}, 'command:restart', ${threadId},
        'provider-runtime.continue',
        ${encodeEffectRequest({ type: "provider-runtime.continue", sourceRunId: run.id })},
        'pending', 0, ${at}, ${at}, ${at}
      )
    `;

    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-restart"),
      threadId,
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("restart-continuation"),
      threadId,
      messageId: MessageId.make("message:restart-continuation"),
      text: "Continue.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
      restartContinuationOfRunId: run.id,
    });
    assert.deepEqual(yield* threadState(threadId), { runs: ["cancelled"], watched: [] });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("cancelling a queued message leaves an earlier restart continuation eligible", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:restart-after-queue-cancel");
    yield* createWatchingThread(threadId, 8);
    yield* send(threadId, "first", "start_immediately");
    yield* send(threadId, "queued", "queue_after_active");
    const [source, queued] = (yield* orchestrator.getThreadProjection(threadId)).runs;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make("event:restart-after-queue-cancel:cut"),
      type: "run.updated",
      threadId,
      runId: source!.id,
      occurredAt: now,
      payload: { ...source!, status: "cancelled", completedAt: now },
    });
    yield* orchestrator.dispatch({
      type: "queued-run.cancel",
      commandId: CommandId.make("cancel-queued-before-restart-continuation"),
      threadId,
      runId: queued!.id,
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("restart-continuation-after-queue-cancel"),
      threadId,
      messageId: MessageId.make("message:restart-continuation-after-queue-cancel"),
      text: "Continue.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
      restartContinuationOfRunId: source!.id,
    });
    const { runs } = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(runs[2]?.restartContinuationOfRunId, source!.id);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["thread.stop", "run.interrupt"] as const)(
  "a successful %s blocks a newer restart continuation when completion timestamps tie",
  (stopType) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:stop-resumed-queue");
      yield* createWatchingThread(threadId, 12);
      yield* send(threadId, "first", "start_immediately");
      yield* send(threadId, "queued", "queue_after_active");
      const now = yield* DateTime.now;
      const [first, queued] = (yield* orchestrator.getThreadProjection(threadId)).runs;
      assert.isDefined(first);
      assert.isDefined(queued);
      for (const run of [first!, queued!]) {
        yield* projections.apply({
          id: EventId.make(`event:stop-resumed-queue:hold:${run.id}`),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload:
            run.id === first!.id
              ? { ...run, status: "completed", completedAt: now }
              : { ...run, queueHeld: true },
        });
      }
      // A later turn runs ahead of the held queue, then recovery cancels it.
      yield* send(threadId, "restart source", "start_immediately");
      const source = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
      yield* projections.apply({
        id: EventId.make("event:stop-resumed-queue:restart-cancelled"),
        type: "run.updated",
        threadId,
        runId: source.id,
        occurredAt: now,
        payload: { ...source, status: "cancelled", startedAt: now, completedAt: now },
      });
      const at = DateTime.formatIso(now);
      yield* sql`
        INSERT INTO orchestration_v2_effect_outbox (
          effect_id, command_id, thread_id, effect_type, payload_json, status,
          attempt_count, available_at, created_at, updated_at
        ) VALUES (
          ${`effect:restart-continuation:${source.id}`}, 'command:restart', ${threadId},
          'provider-runtime.continue',
          ${encodeEffectRequest({ type: "provider-runtime.continue", sourceRunId: source.id })},
          'pending', 0, ${at}, ${at}, ${at}
        )
      `;
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-older-queue"),
        threadId,
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.id === queued!.id,
        )?.status,
        "starting",
      );
      yield* orchestrator.dispatch(
        stopType === "thread.stop"
          ? { type: "thread.stop", commandId: CommandId.make("stop-resumed-queue"), threadId }
          : {
              type: "run.interrupt",
              commandId: CommandId.make("stop-resumed-queue"),
              threadId,
              runId: queued!.id,
              holdQueue: true,
            },
      );
      const stopped = yield* orchestrator.getThreadProjection(threadId);
      const interrupted = stopped.runs.find((run) => run.id === queued!.id)!;
      assert.equal(interrupted.status, "interrupted");
      assert.equal(DateTime.toEpochMillis(interrupted.completedAt!), DateTime.toEpochMillis(now));
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("restart-after-stop"),
        threadId,
        messageId: MessageId.make("message:restart-after-stop"),
        text: "Continue.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "server",
        restartContinuationOfRunId: source.id,
      });
      // The held run resumed after the cancelled source ran, so it sorts after it.
      assert.deepEqual(yield* threadState(threadId), {
        runs: ["completed", "cancelled", "interrupted"],
        watched: [],
      });
    }).pipe(Effect.provide(layerTest.pipe(Layer.provideMerge(TestClock.layer())))),
);

it.effect.each([
  { ending: "cancelled", question: "resolved" },
  { ending: "interrupted", question: "resolved" },
  { ending: "completed", question: "pending" },
  { ending: "failed", question: "pending" },
] as const)(
  "a $ending delegated task leaves its async question $question",
  ({ ending, question }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const parentThreadId = ThreadId.make(`thread:stop-question-parent:${ending}`);
      yield* createWatchingThread(parentThreadId, 20);
      yield* send(parentThreadId, "first", "start_immediately");
      const childThreadId = yield* delegate(parentThreadId, `question task ${ending}`);
      const childRun = (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]!;
      assert.equal(
        (yield* orchestrator.getThreadProjection(childThreadId)).nodes.find(
          (node) => node.id === childRun.rootNodeId,
        )?.runId,
        childRun.id,
      );
      const now = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make("event:stop-question:request"),
        type: "runtime-request.updated",
        threadId: childThreadId,
        runId: childRun.id,
        occurredAt: now,
        payload: {
          id: RuntimeRequestId.make("request:stop-question"),
          nodeId: childRun.rootNodeId!,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: now,
          resolvedAt: null,
        },
      });
      const request = Effect.map(
        orchestrator.getThreadProjection(childThreadId),
        (projection) => projection.runtimeRequests[0],
      );

      // While the task runs, its question stays open.
      yield* orchestrator.recoverDelegatedTask(childThreadId, childRun.id);
      assert.equal((yield* request)?.status, "pending");
      if (ending === "interrupted") {
        // What task_cancel dispatches.
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop-question-child"),
          threadId: childThreadId,
        });
      } else {
        yield* projections.apply({
          id: EventId.make(`event:stop-question:${ending}`),
          type: "run.updated",
          threadId: childThreadId,
          runId: childRun.id,
          occurredAt: now,
          payload: { ...childRun, status: ending, startedAt: now, completedAt: now },
        });
      }
      yield* orchestrator.recoverDelegatedTask(childThreadId, childRun.id);
      assert.equal((yield* request)?.status, question);
      assert.equal((yield* request)?.decision, question === "resolved" ? "cancel" : undefined);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a delegated task that cannot be stopped fails the walk after its siblings stop", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const parentThreadId = ThreadId.make("thread:stop-partial");
    yield* createWatchingThread(parentThreadId, 6);
    yield* send(parentThreadId, "work", "start_immediately");
    const childThreadId = yield* delegate(parentThreadId, "stoppable task");
    const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
    // A task whose thread is gone, listed before the one that can stop.
    yield* projections.apply({
      id: EventId.make("event:stop-partial:missing-task"),
      type: "subagent.updated",
      threadId: parentThreadId,
      runId: task.runId!,
      nodeId: NodeId.make("node:stop-partial:missing"),
      providerInstanceId: instanceId,
      occurredAt: yield* DateTime.now,
      payload: {
        ...task,
        id: NodeId.make("node:stop-partial:missing"),
        childThreadId: ThreadId.make("thread:stop-partial:missing"),
        startedAt: DateTime.subtract(task.startedAt!, { hours: 1 }),
      },
    });

    const walked = yield* Effect.exit(
      threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("stop-partial"),
      }),
    );
    assert.isTrue(Exit.isFailure(walked));
    assert.deepEqual((yield* threadState(childThreadId)).runs, ["interrupted"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("the Stop walk skips finished subagents with nothing left running below them", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const ownership = yield* ExecutionResources.ExecutionResources;
    const sql = yield* SqlClient.SqlClient;
    const parentThreadId = ThreadId.make("thread:stop-finished");
    yield* createWatchingThread(parentThreadId, 8);
    yield* send(parentThreadId, "work", "start_immediately");
    const idle = yield* delegate(parentThreadId, "finished idle task");
    const followUp = yield* delegate(parentThreadId, "finished task with a follow-up");
    const watching = yield* delegate(parentThreadId, "finished task with a monitor");
    const now = yield* DateTime.now;
    const parent = yield* orchestrator.getThreadProjection(parentThreadId);
    for (const task of parent.subagents) {
      yield* projections.apply({
        id: EventId.make(`event:stop-finished:task:${task.id}`),
        type: "subagent.updated",
        threadId: parentThreadId,
        runId: task.runId!,
        nodeId: task.id,
        providerInstanceId: instanceId,
        occurredAt: now,
        payload: { ...task, status: "completed", completedAt: now },
      });
      // Only the follow-up child keeps a live run.
      if (task.childThreadId === followUp) continue;
      for (const run of (yield* orchestrator.getThreadProjection(task.childThreadId!)).runs) {
        yield* projections.apply({
          id: EventId.make(`event:stop-finished:run:${run.id}`),
          type: "run.updated",
          threadId: task.childThreadId!,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "completed", completedAt: now },
        });
      }
    }
    yield* ownership.register("monitor", {
      query: () =>
        Effect.succeed([
          {
            id: "monitor:stop-finished",
            owner: { threadId: watching, taskId: "monitor:stop-finished" },
            workspace: { type: "local" as const, cwd: null },
            state: "running" as const,
            cleanupPin: true,
            stop: { type: "monitor" as const, monitorId: "monitor:stop-finished" },
          },
        ]),
      stop: () => Effect.void,
    });

    yield* threads.stopDelegatedTasks({
      threadId: parentThreadId,
      commandId: CommandId.make("stop-finished"),
    });

    const stopped = yield* sql<{ readonly command_id: string }>`
      SELECT command_id FROM orchestration_command_receipts
      WHERE command_id LIKE 'stop-finished:stop:%'
    `;
    assert.sameMembers(
      stopped.map((row) => row.command_id),
      [`stop-finished:stop:${followUp}`, `stop-finished:stop:${watching}`],
    );
    assert.notInclude(
      stopped.map((row) => row.command_id),
      `stop-finished:stop:${idle}`,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("thread.stop on a finished thread refuses a late agent watch", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:stop-finished");
    yield* createWatchingThread(threadId, 9);
    yield* send(threadId, "work", "start_immediately");
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    yield* projections.apply({
      id: EventId.make("event:stop-finished:completed"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "completed", startedAt: now, completedAt: now },
    });

    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-finished"),
      threadId,
    });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(threadId, 10))));
    assert.deepEqual(yield* threadState(threadId), { runs: ["completed"], watched: [] });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("thread.stop marks a turn it cannot interrupt so a late agent watch is refused", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:stop-lost-session");
    yield* createWatchingThread(threadId, 11);
    yield* send(threadId, "work", "start_immediately");
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    // The turn is running, but its provider session is gone, so the interrupt fails.
    yield* projections.apply({
      id: EventId.make("event:stop-lost-session:running"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "running", startedAt: now },
    });
    yield* projections.apply({
      id: EventId.make("event:stop-lost-session:turn"),
      type: "provider-turn.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: ProviderTurnId.make("provider-turn:stop-lost-session"),
        providerThreadId: run.providerThreadId!,
        nodeId: run.rootNodeId!,
        runAttemptId: run.activeAttemptId!,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    });

    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-lost-session"),
      threadId,
    });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(threadId, 12))));
    assert.deepEqual(yield* threadState(threadId), { runs: ["running"], watched: [] });
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["missing session", "completed", "failed", "cancelled"] as const)(
  "a native child Stop only settles a confirmed %s outcome and preserves its owner and sibling",
  (providerState) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:native-child-stop");
      yield* createWatchingThread(threadId, 20);
      yield* send(threadId, "owner", "start_immediately");
      yield* delegate(threadId, "native-child-fixture");
      const before = yield* orchestrator.getThreadProjection(threadId);
      const run = before.runs[0]!;
      const now = yield* DateTime.now;
      const subagent = {
        ...before.subagents[0]!,
        origin: "provider_native" as const,
        driver: CLAUDE_PROVIDER,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        nativeTaskRef: {
          driver: CLAUDE_PROVIDER,
          nativeId: "claude-task",
          strength: "strong" as const,
        },
        status: "running" as const,
        startedAt: now,
      };
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:agent"),
        type: "subagent.updated",
        threadId,
        runId: run.id,
        nodeId: subagent.id,
        occurredAt: now,
        payload: subagent,
      });
      const sibling = {
        ...subagent,
        id: NodeId.make("node:native-stop-sibling"),
        childThreadId: null,
      };
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:sibling"),
        type: "subagent.updated",
        threadId,
        runId: run.id,
        nodeId: sibling.id,
        occurredAt: now,
        payload: sibling,
      });
      const item = before.turnItems.find(
        (item) => item.type === "subagent" && item.subagentId === subagent.id,
      )!;
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:item"),
        type: "turn-item.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...item, status: "running", completedAt: null },
      });
      const childRoot = {
        ...before.nodes.find((node) => node.id === run.rootNodeId)!,
        id: NodeId.make("node:native-stop-child-root"),
        threadId: subagent.childThreadId!,
        runId: null,
        parentNodeId: null,
        status: "running" as const,
        countsForRun: false,
        completedAt: null,
      };
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:child-root"),
        type: "node.updated",
        threadId: childRoot.threadId,
        nodeId: childRoot.id,
        occurredAt: now,
        payload: childRoot,
      });
      const childTurnId = ProviderTurnId.make("turn:native-stop-child");
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:child-turn"),
        type: "provider-turn.updated",
        threadId: childRoot.threadId,
        nodeId: childRoot.id,
        occurredAt: now,
        payload: {
          id: childTurnId,
          providerThreadId: ProviderThreadId.make("provider-thread:native-stop-child"),
          nodeId: childRoot.id,
          runAttemptId: null,
          nativeTurnRef: null,
          ordinal: 1,
          status: "running",
          startedAt: now,
          completedAt: null,
        },
      });
      const providerThread = before.providerThreads.find(
        (thread) => thread.id === run.providerThreadId,
      )!;
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:provider-thread"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...providerThread,
          driver: CLAUDE_PROVIDER,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          providerSessionId: ProviderSessionId.make("session:native-child-stop"),
        },
      });
      const providerTurnId = ProviderTurnId.make("turn:native-child-stop");
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:provider-turn"),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: providerTurnId,
          providerThreadId: providerThread.id,
          nodeId: run.rootNodeId!,
          runAttemptId: run.activeAttemptId!,
          nativeTurnRef: null,
          ordinal: 1,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      // The owner has finished but its child and queued prompt remain.
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:owner-completed"),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status: "completed", startedAt: now, completedAt: now },
      });
      yield* send(threadId, "queued", "queue_after_active");
      const stateBefore = yield* threadState(threadId);
      const eventStore = yield* EventStore.EventStoreV2;
      const afterSequence = yield* eventStore.latestSequence({ threadId });
      const confirmedStatus =
        providerState === "completed" || providerState === "failed" || providerState === "cancelled"
          ? providerState
          : null;
      const confirmedOutcome =
        confirmedStatus === null
          ? undefined
          : { status: confirmedStatus, completedAt: now, result: "Actual provider outcome" };
      const commandId = CommandId.make("stop-native-child");
      yield* orchestrator.dispatch({
        type: "subagent.stop",
        commandId,
        threadId,
        runId: run.id,
        subagentId: subagent.id,
      });
      assert.deepEqual(yield* threadState(threadId), stateBefore);
      const effects = yield* sql<{ payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_effect_outbox WHERE command_id = ${commandId}
    `;
      assert.equal(effects.length, 1);
      assert.deepEqual(JSON.parse(effects[0]!.payload_json), {
        type: "provider-turn.interrupt",
        providerSessionId: "session:native-child-stop",
        providerThreadId: providerThread.id,
        providerTurnId,
        subagent: { id: subagent.id, nativeTaskId: "claude-task" },
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).subagents[0]?.status,
        "running",
      );
      const unrelated = yield* Effect.exit(
        orchestrator.dispatch({
          type: "subagent.stop",
          commandId: CommandId.make("stop-unknown-child"),
          threadId,
          runId: run.id,
          subagentId: NodeId.make("unknown-child"),
        }),
      );
      assert.isTrue(Exit.isFailure(unrelated));
      // The provider outcome predates the delayed projection repair.
      yield* TestClock.adjust("1 second");
      // Only execute Stop's durable effect, with no terminal event ingestion.
      yield* sql`DELETE FROM orchestration_v2_effect_outbox WHERE command_id != ${commandId}`;
      if (providerState === "missing session") {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* worker.drain();
      } else {
        yield* orchestrator.dispatch({
          type: "thread.background-work.settle",
          commandId: CommandId.make("repair-native-child"),
          threadId,
          providerThreadId: providerThread.id,
          providerTurnId,
          subagent: { id: subagent.id, stoppedAt: now, outcome: confirmedOutcome! },
        });
      }
      const settled = yield* orchestrator.getThreadProjection(threadId);
      const cancelled = settled.subagents.find((task) => task.id === subagent.id)!;
      if (confirmedOutcome === undefined) {
        const events = yield* eventStore.read({ threadId, afterSequence }).pipe(Stream.runCollect);
        assert.isFalse(
          events.some(
            ({ event }) =>
              (event.type === "subagent.updated" ||
                event.type === "node.updated" ||
                event.type === "turn-item.updated") &&
              ["completed", "failed", "cancelled", "interrupted"].includes(event.payload.status),
          ),
        );
        assert.equal(cancelled.status, "running");
        assert.equal(
          (yield* orchestrator.getThreadProjection(childRoot.threadId)).nodes.find(
            (node) => node.id === childRoot.id,
          )?.status,
          "running",
        );
        assert.deepEqual(yield* threadState(threadId), stateBefore);
        return;
      }

      // Cached clients resume from this sequence, so all lifecycle repairs
      // must be stored in the parent stream, not just applied to projections.
      const repaired = yield* eventStore.read({ threadId, afterSequence }).pipe(Stream.runCollect);
      const terminal = repaired.flatMap(({ event }) =>
        (event.type === "subagent.updated" ||
          event.type === "node.updated" ||
          event.type === "turn-item.updated") &&
        event.payload.status === confirmedStatus
          ? [event]
          : [],
      );
      assert.deepEqual(terminal.map((event) => event.type).sort(), [
        "node.updated",
        "subagent.updated",
        "turn-item.updated",
      ]);
      for (const event of terminal) {
        assert.equal(event.nodeId, subagent.id);
        assert.equal(
          DateTime.toEpochMillis(event.payload.completedAt!),
          DateTime.toEpochMillis(confirmedOutcome!.completedAt),
        );
        if (event.type === "subagent.updated" || event.type === "turn-item.updated") {
          assert.isDefined(event.payload.updatedAt);
        }
      }

      assert.equal(cancelled.status, confirmedStatus);
      assert.isNotNull(cancelled.completedAt);
      assert.equal(
        DateTime.toEpochMillis(cancelled.completedAt!),
        DateTime.toEpochMillis(confirmedOutcome!.completedAt),
      );
      assert.equal(cancelled.result, confirmedOutcome!.result);
      assert.equal(
        settled.turnItems.find((candidate) => candidate.id === item.id)?.status,
        confirmedStatus,
      );
      const child = yield* orchestrator.getThreadProjection(childRoot.threadId);
      assert.equal(child.nodes.find((node) => node.id === childRoot.id)?.status, confirmedStatus);
      assert.equal(
        child.providerTurns.find((turn) => turn.id === childTurnId)?.status,
        confirmedStatus,
      );
      assert.isNotNull(child.nodes.find((node) => node.id === childRoot.id)?.completedAt);
      assert.equal(settled.subagents.find((task) => task.id === sibling.id)?.status, "running");
      assert.deepEqual(yield* threadState(threadId), stateBefore);
      // An old Stop follow-up cannot cancel a genuine subsequent resume.
      yield* TestClock.adjust("1 second");
      const resumedAt = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:resume"),
        type: "subagent.updated",
        threadId,
        runId: run.id,
        nodeId: subagent.id,
        occurredAt: resumedAt,
        payload: { ...cancelled, status: "running", startedAt: resumedAt, completedAt: null },
      });
      yield* orchestrator.dispatch({
        type: "thread.background-work.settle",
        commandId: CommandId.make("old-stop-after-resume"),
        threadId,
        providerThreadId: providerThread.id,
        providerTurnId,
        subagent: { id: subagent.id, stoppedAt: now, outcome: confirmedOutcome },
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
          (task) => task.id === subagent.id,
        )?.status,
        "running",
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each([false, true])(
  "Stop preserves or disposes remote subagents without a local interrupt (keepHelpers=%s)",
  (keepHelpers) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const parentThreadId = ThreadId.make("thread:remote-stop");
      yield* createWatchingThread(parentThreadId, 1);
      yield* send(parentThreadId, "active", "start_immediately");
      const localChild = yield* delegate(parentThreadId, "remote child");
      const before = yield* orchestrator.getThreadProjection(parentThreadId);
      const task = before.subagents[0]!;
      yield* projections.apply({
        id: EventId.make("event:remote-stop-task"),
        type: "subagent.updated",
        threadId: parentThreadId,
        occurredAt: yield* DateTime.now,
        payload: {
          ...task,
          remote: { environmentId: EnvironmentId.make("studio-test") },
          childThreadId: ThreadId.make("thread:absent-remote-child"),
        },
      });
      const commandId = CommandId.make("command:remote-stop");
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId,
        threadId: parentThreadId,
        runId: before.runs[0]!.id,
        holdQueue: true,
        keepHelpers,
      });
      yield* threads.stopDelegatedTasks({ threadId: parentThreadId, commandId });
      const after = yield* orchestrator.getThreadProjection(parentThreadId);
      assert.equal(after.subagents[0]?.status, "running");
      assert.equal(
        after.subagents[0]?.completionDelivery?.state,
        keepHelpers ? task.completionDelivery?.state : "disposed",
      );
      assert.deepEqual((yield* threadState(localChild)).runs, ["starting"]);
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["pending", "waiting", "running"] as const)(
  "%s local admissions survive a fresh projection reader and release their checkout pin on completion",
  (status) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const ownership = yield* ExecutionResources.ExecutionResources;
      const parentThreadId = ThreadId.make("thread:ownership-recovery");
      yield* createWatchingThread(parentThreadId, 1);
      yield* send(parentThreadId, "work", "start_immediately");
      const childThreadId = yield* delegate(parentThreadId, "owned child");
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("ownership-cwd"),
        threadId: childThreadId,
        worktreePath: "/worktrees/owned/nested",
      });
      const parent = yield* orchestrator.getThreadProjection(parentThreadId);
      const task = parent.subagents[0]!;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* projections.apply({
        id: EventId.make("event:ownership-admission"),
        type: "subagent.updated",
        threadId: parentThreadId,
        occurredAt: yield* DateTime.now,
        payload: { ...task, status },
      });
      const active = yield* ownership.query({ directory: "/worktrees/owned", pinsOnly: true });
      assert.lengthOf(active, 1);
      assert.equal(active[0]!.owner.threadId, parentThreadId);
      const coldContext = yield* Layer.build(Layer.fresh(ProjectionStore.layer));
      const cold = Context.get(coldContext, ProjectionStore.ProjectionStoreV2);
      assert.deepEqual(yield* cold.getExecutionResources(parentThreadId, true), active);
      yield* cold.apply({
        id: EventId.make("event:ownership-release"),
        type: "subagent.updated",
        threadId: parentThreadId,
        occurredAt: yield* DateTime.now,
        payload: { ...task, status: "completed" },
      });
      assert.deepEqual(
        yield* ownership.query({ directory: "/worktrees/owned", pinsOnly: true }),
        [],
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.live.each(["thread.stop", "thread.archive", "thread.delete"] as const)(
  "%s stops owned durable monitors and local descendants through ownership adapters",
  (type) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "ownership-stop-" });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const monitors = yield* MonitorService.MonitorService;
        const ownership = yield* ExecutionResources.ExecutionResources;
        const parentThreadId = ThreadId.make(`thread:owned:${type}`);
        yield* createWatchingThread(parentThreadId, 1);
        yield* send(parentThreadId, "work", "start_immediately");
        const childThreadId = yield* delegate(parentThreadId, "owned child");
        yield* delegate(childThreadId, "owned grandchild");
        for (const threadId of [parentThreadId, childThreadId]) {
          yield* monitors.start({
            threadId,
            cwd: home,
            command: "sleep 60",
            description: "Owned job",
            requestNamespace: "test",
            durable: true,
          });
        }
        assert.lengthOf(yield* ownership.query({ directory: home, pinsOnly: true }), 2);
        const commandId = CommandId.make(`owned:${type}`);
        yield* orchestrator.dispatch({ type, commandId, threadId: parentThreadId });
        // This fixture deliberately has no effect worker. Execute the durable
        // cascade's service method, just as delegated-tasks.stop does on replay.
        yield* threads.stopDelegatedTasks({ threadId: parentThreadId, commandId });
        assert.deepEqual(yield* monitors.list(parentThreadId), []);
        assert.deepEqual(yield* monitors.list(childThreadId), []);
        assert.deepEqual((yield* threadState(childThreadId)).runs, ["interrupted"]);
        assert.deepEqual(yield* ownership.query({ directory: home, pinsOnly: true }), []);
      }).pipe(
        Effect.provide(
          layerTest.pipe(
            Layer.provideMerge(
              MonitorService.layer.pipe(
                Layer.provideMerge(ServerConfig.layerTest(process.cwd(), home)),
                Layer.provide(NodeServices.layer),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
