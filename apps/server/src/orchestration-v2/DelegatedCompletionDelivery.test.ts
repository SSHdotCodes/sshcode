import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { delegatedCompletionWakeDetail } from "./NotificationMailbox.ts";
import { taskReference } from "./taskReference.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as MonitorService from "../monitors/MonitorService.ts";
import * as Queue from "effect/Queue";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as DelegatedTaskReconcileWorker from "./DelegatedTaskReconcileWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { continueRestartedRun } from "./RestartContinuation.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ProviderTurnStartServiceTestkit from "./ProviderTurnStartService.testkit.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-delegated-completion-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const layerVcsDriverRegistryTest = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
  Layer.provide(layerVcsDriverRegistryTest),
);

const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by delegated completion tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test",
  },
  displayName: "Codex test",
  enabled: true,
  // No supportedRuntimeModes: every runtime mode runs as stored.
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerTestProviderInstanceRegistry = Layer.succeed(
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  {
    getInstance: (instanceId) =>
      Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
    listInstances: Effect.succeed([providerInstance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  },
);

const layerTest = Layer.mergeAll(RuntimeLayer.layer, RuntimeLayer.layerEventSink).pipe(
  Layer.provideMerge(RuntimeLayer.layerProjectService),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(ProviderTurnStartServiceTestkit.layer),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerPlatformTest),
);

const seedParentWithTerminalTask = (input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly runId: RunId;
  readonly rootNodeId: NodeId;
  readonly taskId: NodeId;
  readonly deliveryState: "pending" | "delivered" | "claimed" | "acknowledged" | "disposed";
  readonly completionWake?: "always" | "settled_only";
  readonly deliveryTaskIds?: ReadonlyArray<NodeId>;
  readonly now: DateTime.Utc;
}) =>
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const providerThreadId = ProviderThreadId.make(
      `provider-thread:${String(input.threadId).replace("thread:", "")}`,
    );

    yield* projects.create({
      commandId: CommandId.make(`command:seed-project:${input.threadId}`),
      projectId: input.projectId,
      title: "Delegated completion delivery",
      workspaceRoot: `/workspace/${input.projectId}`,
    });

    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:seed-create:${input.threadId}`),
      threadId: input.threadId,
      projectId: input.projectId,
      title: "Delegated completion delivery",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });

    yield* eventSink.write({
      commandId: CommandId.make(`command:seed-projection:${input.threadId}`),
      events: [
        {
          id: EventId.make(`event:seed-provider-thread:${input.threadId}`),
          type: "provider-thread.updated",
          threadId: input.threadId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId: null,
            appThreadId: input.threadId,
            ownerNodeId: input.rootNodeId,
            nativeThreadRef: {
              driver,
              nativeId: `native:${input.threadId}`,
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: input.now,
            updatedAt: input.now,
          },
        },
        {
          id: EventId.make(`event:seed-run:${input.threadId}`),
          type: "run.updated",
          threadId: input.threadId,
          runId: input.runId,
          nodeId: input.rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: input.runId,
            threadId: input.threadId,
            ordinal: 1,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make(`message:seed-user:${input.threadId}`),
            rootNodeId: input.rootNodeId,
            activeAttemptId: null,
            status: "running",
            requestedAt: input.now,
            startedAt: input.now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
            delegatedCompletion: {
              disposition: "open",
              nextGeneration: 2,
              delivery:
                input.deliveryTaskIds === undefined
                  ? null
                  : {
                      generation: 1,
                      messageId: MessageId.make(`message:delegated-delivery:${input.threadId}`),
                      taskIds: input.deliveryTaskIds,
                    },
            },
          },
        },
        {
          id: EventId.make(`event:seed-task:${input.threadId}`),
          type: "subagent.updated",
          threadId: input.threadId,
          runId: input.runId,
          nodeId: input.taskId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: input.taskId,
            threadId: input.threadId,
            runId: input.runId,
            parentNodeId: input.rootNodeId,
            origin: "app_owned",
            createdBy: "agent",
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerThreadId: null,
            childThreadId: null,
            nativeTaskRef: null,
            prompt: "Inspect the delivered ownership edge.",
            title: null,
            model: null,
            completionWake: input.completionWake ?? "settled_only",
            completionDelivery: {
              state: input.deliveryState,
              observedByRunId: input.deliveryState === "acknowledged" ? input.runId : null,
            },
            status: "completed",
            result: "child finished",
            startedAt: input.now,
            completedAt: input.now,
            updatedAt: input.now,
          },
        },
      ],
    });
  });

it.layer(layerTest)("delegated completion delivery repairs", (it) => {
  it.effect("acceptance acknowledges its results and batches pending siblings", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("mailbox-batch");
      const runId = RunId.make("mailbox-parent");
      const taskId = NodeId.make("mailbox-first");
      const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
      yield* seedParentWithTerminalTask({
        threadId,
        runId,
        projectId: ProjectId.make("mailbox-project"),
        rootNodeId: NodeId.make("mailbox-root"),
        taskId,
        deliveryState: "claimed",
        completionWake: "always",
        deliveryTaskIds: [taskId],
        now,
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const task = projection.subagents[0]!;
      const pendingIds = [NodeId.make("mailbox-second"), NodeId.make("mailbox-third")];
      yield* sink.write({
        events: [
          {
            id: EventId.make("mailbox-message"),
            type: "message.updated",
            threadId,
            runId,
            occurredAt: now,
            payload: {
              id: messageId,
              threadId,
              runId,
              nodeId: task.parentNodeId,
              role: "user",
              text: "Background task finished",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "server",
              createdAt: now,
              updatedAt: now,
              delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
            },
          },
          ...pendingIds.map((id) => ({
            id: EventId.make(`event:${id}`),
            type: "subagent.updated" as const,
            threadId,
            runId,
            nodeId: id,
            occurredAt: now,
            payload: {
              ...task,
              id,
              completionDelivery: { state: "pending" as const, observedByRunId: null },
            },
          })),
        ],
      });
      yield* orchestrator.dispatch({
        type: "notification.delivery.accept",
        commandId: CommandId.make("accept-first"),
        threadId,
        messageId,
      });
      const accepted = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        accepted.subagents.find((row) => row.id === taskId)?.completionDelivery?.state,
        "acknowledged",
      );
      const cohort = accepted.runs.find((row) => row.id === runId)?.delegatedCompletion;
      assert.deepEqual(cohort?.delivery?.taskIds, pendingIds);
      assert.equal(cohort?.delivery?.generation, 2);
      for (const id of pendingIds) {
        assert.deepEqual(accepted.subagents.find((row) => row.id === id)?.completionDelivery, {
          state: "claimed",
          observedByRunId: null,
        });
      }
      yield* orchestrator.dispatch({
        type: "notification.delivery.accept",
        commandId: CommandId.make("repeat-old-acceptance"),
        threadId,
        messageId,
      });
      const duplicate = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(duplicate.runs.find((row) => row.id === runId)?.delegatedCompletion, cohort);
    }),
  );

  it.effect("acceptance batches a settled_only sibling once its spawning run ended", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("mailbox-mixed");
      const runId = RunId.make("mailbox-mixed-parent");
      const taskId = NodeId.make("mailbox-mixed-always");
      const siblingId = NodeId.make("mailbox-mixed-settled-only");
      const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
      yield* seedParentWithTerminalTask({
        threadId,
        runId,
        projectId: ProjectId.make("mailbox-mixed-project"),
        rootNodeId: NodeId.make("mailbox-mixed-root"),
        taskId,
        deliveryState: "claimed",
        completionWake: "always",
        deliveryTaskIds: [taskId],
        now,
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const task = projection.subagents[0]!;
      const spawningRun = projection.runs.find((row) => row.id === runId)!;
      // A restart cut the spawning run; its continuation is the live run now.
      yield* sink.write({
        events: [
          {
            ...runEvent({ threadId, runId, ordinal: 1, status: "cancelled", now }),
            payload: { ...spawningRun, status: "cancelled" as const, completedAt: now },
          },
          runEvent({
            threadId,
            runId: RunId.make("mailbox-mixed-continuation"),
            ordinal: 2,
            status: "running",
            now,
          }),
          {
            id: EventId.make("mailbox-mixed-message"),
            type: "message.updated",
            threadId,
            runId,
            occurredAt: now,
            payload: {
              id: messageId,
              threadId,
              runId,
              nodeId: task.parentNodeId,
              role: "user",
              text: "Background task finished",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "server",
              createdAt: now,
              updatedAt: now,
              delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
            },
          },
          {
            id: EventId.make(`event:${siblingId}`),
            type: "subagent.updated" as const,
            threadId,
            runId,
            nodeId: siblingId,
            occurredAt: now,
            payload: {
              ...task,
              id: siblingId,
              completionWake: "settled_only" as const,
              completionDelivery: { state: "pending" as const, observedByRunId: null },
            },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "notification.delivery.accept",
        commandId: CommandId.make("accept-mixed"),
        threadId,
        messageId,
      });
      const accepted = yield* orchestrator.getThreadProjection(threadId);
      const cohort = accepted.runs.find((row) => row.id === runId)?.delegatedCompletion;
      assert.deepEqual(cohort?.delivery?.taskIds, [siblingId]);
      assert.equal(
        accepted.subagents.find((row) => row.id === siblingId)?.completionDelivery?.state,
        "claimed",
      );
    }),
  );

  it.effect.each(["completed", "failed", "cancelled", "interrupted"] as const)(
    "batches %s completion text and metadata from the same live cohort",
    (status) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make(`thread:delegated-delivery-live-cohort-${status}`);
        const projectId = ProjectId.make(`project:delegated-delivery-live-cohort-${status}`);
        const runId = RunId.make(`run:delegated-delivery-live-cohort-${status}`);
        const rootNodeId = NodeId.make(`node:delegated-delivery-live-cohort-root-${status}`);
        const firstTaskId = NodeId.make(`node:delegated-delivery-live-cohort-first-${status}`);
        const secondTaskId = NodeId.make(`node:delegated-delivery-live-cohort-second-${status}`);
        const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);

        yield* seedParentWithTerminalTask({
          threadId,
          projectId,
          runId,
          rootNodeId,
          taskId: firstTaskId,
          deliveryState: "claimed",
          completionWake: "always",
          deliveryTaskIds: [firstTaskId, secondTaskId],
          now,
        });

        const sink = yield* EventSink.EventSinkV2;
        const task = (yield* orchestrator.getThreadProjection(threadId)).subagents[0]!;
        yield* sink.write({
          events: [firstTaskId, secondTaskId].map((id) => ({
            id: EventId.make(`event:cohort:${id}`),
            type: "subagent.updated" as const,
            threadId,
            runId,
            nodeId: id,
            occurredAt: now,
            payload: {
              ...task,
              id,
              status,
              model: "gpt-5.4",
              result: `Result for ${taskReference(id)}`,
            },
          })),
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`command:delegated-delivery-live-cohort-${status}`),
          threadId,
          messageId,
          text: `Delegated task ${firstTaskId} reached a terminal state.`,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
          delegatedCompletion: {
            parentRunId: runId,
            generation: 1,
            taskIds: [firstTaskId],
          },
        });

        const projection = yield* orchestrator.getThreadProjection(threadId);
        const message = projection.messages.find((candidate) => candidate.id === messageId);
        assert.deepEqual(message?.delegatedCompletion?.taskIds, [firstTaskId, secondTaskId]);
        assert.include(message?.text ?? "", taskReference(firstTaskId));
        assert.include(message?.text ?? "", taskReference(secondTaskId));
        assert.notInclude(message?.text ?? "", String(firstTaskId));
        assert.include(
          message?.text ?? "",
          `Subagent ${taskReference(firstTaskId)}: ${status} (codex/gpt-5.4)`,
        );
        assert.include(message?.text ?? "", `Result for ${taskReference(firstTaskId)}`);
        assert.include(message?.text ?? "", `Result for ${taskReference(secondTaskId)}`);
        assert.notInclude(message?.text ?? "", "task_status");
        assert.lengthOf(
          projection.messages.filter((row) => row.delegatedCompletion !== undefined),
          1,
        );
      }),
  );

  it.effect.each(["x", "🙂"])("caps each %s result at 6 KiB without splitting UTF-8", (character) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make(`thread:completion-cap-${character.length}`);
      const runId = RunId.make(`run:completion-cap-${character.length}`);
      const firstId = NodeId.make(`node:completion-cap-first-${character.length}`);
      const secondId = NodeId.make(`node:completion-cap-second-${character.length}`);
      const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
      yield* seedParentWithTerminalTask({
        threadId,
        runId,
        projectId: ProjectId.make(`project:completion-cap-${character.length}`),
        rootNodeId: NodeId.make(`node:completion-cap-root-${character.length}`),
        taskId: firstId,
        deliveryState: "claimed",
        completionWake: "always",
        deliveryTaskIds: [firstId, secondId],
        now,
      });
      const task = (yield* orchestrator.getThreadProjection(threadId)).subagents[0]!;
      const full = `Result head: ${character.repeat(7000)} END`;
      yield* sink.write({
        events: [firstId, secondId].map((id) => ({
          id: EventId.make(`event:cap:${id}`),
          type: "subagent.updated" as const,
          threadId,
          runId,
          nodeId: id,
          occurredAt: now,
          payload: {
            ...task,
            id,
            model: "gpt-5.4",
            result: full,
          },
        })),
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`command:completion-cap-${character.length}`),
        threadId,
        messageId,
        text: "Old wake",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
        delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [firstId, secondId] },
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const text = projection.messages.find((row) => row.id === messageId)!.text;
      const results = text.split("\n\n");
      assert.lengthOf(results, 2);
      for (const [index, result] of results.entries()) {
        assert.isAtMost(Buffer.byteLength(result, "utf8"), 6144);
        assert.isAbove(Buffer.byteLength(result, "utf8"), 6144 - Buffer.byteLength(character));
        assert.include(result, "Result head:");
        assert.notInclude(result, " END");
        assert.notInclude(result, "�");
        const reference = taskReference([firstId, secondId][index]!);
        const [preview, rest] = result.split("\n… rest: ");
        const shown = preview!.slice(preview!.indexOf("Result head:"));
        assert.equal(rest, `task_status({taskId:"${reference}",summaryOffset:${shown.length}})`);
        assert.equal(shown + full.slice(shown.length), full);
      }
    }),
  );

  it.effect("does not re-offer when wake-policy upgrades after delivered ownership settled", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:delegated-delivery-a1");
      const projectId = ProjectId.make("project:delegated-delivery-a1");
      const runId = RunId.make("run:delegated-delivery-a1");
      const rootNodeId = NodeId.make("node:delegated-delivery-a1-root");
      const taskId = NodeId.make("node:delegated-delivery-a1-task");

      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId,
        deliveryState: "delivered",
        completionWake: "settled_only",
        now,
      });

      const upgrade = yield* orchestrator.dispatch({
        type: "delegated_task.wake-policy",
        commandId: CommandId.make("command:delegated-delivery-a1:wake-policy"),
        parentThreadId: threadId,
        taskId,
        completionWake: "always",
      });

      const projection = yield* orchestrator.getThreadProjection(threadId);
      const task = projection.subagents.find((candidate) => candidate.id === taskId);
      const parentRun = projection.runs.find((candidate) => candidate.id === runId);

      assert.equal(task?.completionWake, "always");
      assert.deepEqual(task?.completionDelivery, {
        state: "delivered",
        observedByRunId: null,
      });
      assert.deepEqual(parentRun?.delegatedCompletion, {
        disposition: "open",
        nextGeneration: 2,
        delivery: null,
      });
      assert.isFalse(
        upgrade.storedEvents.some(
          (stored) =>
            stored.event.type === "subagent.updated" &&
            stored.event.payload.id === taskId &&
            stored.event.payload.completionDelivery?.state === "claimed",
        ),
      );
      assert.isFalse(
        upgrade.storedEvents.some(
          (stored) =>
            stored.event.type === "run.updated" &&
            stored.event.payload.id === runId &&
            stored.event.payload.delegatedCompletion?.delivery !== null &&
            stored.event.payload.delegatedCompletion?.delivery !== undefined,
        ),
      );
    }),
  );

  it.effect.each([
    "completed",
    "failed",
    "cancelled",
    "interrupted",
    "rolled_back",
    "running",
  ] as const)("resolves an observed task steered into a %s run", (status) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make(`observed-delivery-${status}`);
      const runId = RunId.make(`observed-parent-${status}`);
      const taskId = NodeId.make(`observed-task-${status}`);
      const deliveryRunId = RunId.make(`observed-wake-${status}`);
      const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
      yield* seedParentWithTerminalTask({
        threadId,
        runId,
        projectId: ProjectId.make(`observed-project-${status}`),
        rootNodeId: NodeId.make(`observed-root-${status}`),
        taskId,
        deliveryState: "claimed",
        deliveryTaskIds: [taskId],
        now,
      });
      // A steer is not the run's original input, so terminal-run finalization
      // does not settle this delivery through getRunMessage.
      yield* sink.write({
        commandId: reconcileCommandId(`observed-delivery-${status}`),
        events: [
          runEvent({
            threadId,
            runId: deliveryRunId,
            ordinal: 2,
            status,
            now,
          }),
          {
            id: EventId.make(`observed-message-${status}`),
            type: "message.updated",
            threadId,
            runId: deliveryRunId,
            occurredAt: now,
            payload: {
              id: messageId,
              threadId,
              runId: deliveryRunId,
              nodeId: null,
              role: "user",
              text: "Background task finished",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "server",
              createdAt: now,
              updatedAt: now,
              delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
            },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "delegated_task.completion-delivery.acknowledge",
        commandId: CommandId.make(`observe-delivery-${status}`),
        parentThreadId: threadId,
        taskId,
        observedByRunId: runId,
      });
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        after.subagents.find((task) => task.id === taskId)?.completionDelivery?.state,
        "acknowledged",
      );
      const delivery = after.runs.find((run) => run.id === runId)?.delegatedCompletion?.delivery;
      if (status === "running") {
        // Keep the in-flight generation until its provider accepts or settles it.
        assert.deepEqual(delivery?.taskIds, []);
      } else {
        assert.isNull(delivery);
      }
    }),
  );

  it.effect("cancels a queued wake with its root and attempt once its last task is read", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("observed-delivery-queued");
      const runId = RunId.make("observed-parent-queued");
      const taskId = NodeId.make("observed-task-queued");
      const wakeRunId = RunId.make("observed-wake-queued");
      const wakeRootId = NodeId.make("observed-wake-root-queued");
      const wakeAttemptId = RunAttemptId.make("observed-wake-attempt-queued");
      const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
      yield* seedParentWithTerminalTask({
        threadId,
        runId,
        projectId: ProjectId.make("observed-project-queued"),
        rootNodeId: NodeId.make("observed-root-queued"),
        taskId,
        deliveryState: "claimed",
        deliveryTaskIds: [taskId],
        now,
      });
      const wake = runEvent({
        threadId,
        runId: wakeRunId,
        ordinal: 2,
        status: "queued",
        now,
        userMessageId: messageId,
      });
      yield* sink.write({
        commandId: reconcileCommandId("observed-delivery-queued"),
        events: [
          {
            ...wake,
            payload: {
              ...wake.payload,
              rootNodeId: wakeRootId,
              activeAttemptId: wakeAttemptId,
              startedAt: null,
              completedAt: null,
            },
          },
          {
            id: EventId.make("observed-wake-root-queued"),
            type: "node.updated",
            threadId,
            runId: wakeRunId,
            nodeId: wakeRootId,
            occurredAt: now,
            payload: {
              id: wakeRootId,
              threadId,
              runId: wakeRunId,
              parentNodeId: null,
              rootNodeId: wakeRootId,
              kind: "root_turn",
              status: "pending",
              countsForRun: true,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: null,
              completedAt: null,
            },
          },
          {
            id: EventId.make("observed-wake-attempt-queued"),
            type: "run-attempt.updated",
            threadId,
            runId: wakeRunId,
            occurredAt: now,
            payload: {
              id: wakeAttemptId,
              runId: wakeRunId,
              attemptOrdinal: 1,
              rootNodeId: wakeRootId,
              providerInstanceId: modelSelection.instanceId,
              providerThreadId: ProviderThreadId.make("provider-thread:observed-delivery-queued"),
              providerTurnId: null,
              reason: "initial",
              status: "pending",
              startedAt: null,
              completedAt: null,
            },
          },
          {
            id: EventId.make("observed-message-queued"),
            type: "message.updated",
            threadId,
            runId: wakeRunId,
            occurredAt: now,
            payload: {
              id: messageId,
              threadId,
              runId: wakeRunId,
              nodeId: null,
              role: "user",
              text: "Background task finished",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "server",
              createdAt: now,
              updatedAt: now,
              delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
            },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "delegated_task.completion-delivery.acknowledge",
        commandId: CommandId.make("observe-delivery-queued"),
        parentThreadId: threadId,
        taskId,
        observedByRunId: runId,
      });
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(after.runs.find((run) => run.id === wakeRunId)?.status, "cancelled");
      assert.equal(after.nodes.find((node) => node.id === wakeRootId)?.status, "cancelled");
      assert.equal(
        after.attempts.find((attempt) => attempt.id === wakeAttemptId)?.status,
        "cancelled",
      );
    }),
  );

  it.effect(
    "treats repeated acknowledge and dispose with distinct command IDs as successful no-ops",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:delegated-delivery-a2");
        const projectId = ProjectId.make("project:delegated-delivery-a2");
        const runId = RunId.make("run:delegated-delivery-a2");
        const rootNodeId = NodeId.make("node:delegated-delivery-a2-root");
        const taskId = NodeId.make("node:delegated-delivery-a2-task");

        yield* seedParentWithTerminalTask({
          threadId,
          projectId,
          runId,
          rootNodeId,
          taskId,
          deliveryState: "delivered",
          completionWake: "always",
          now,
        });

        // Distinct command IDs mirror task_status vs t3_thread_read racing after
        // their shared read preflight saw delivered ownership.
        const firstAck = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make("command:delegated-delivery-a2:ack-task-status"),
          parentThreadId: threadId,
          taskId,
          observedByRunId: runId,
        });
        const secondAck = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make("command:delegated-delivery-a2:ack-thread-read"),
          parentThreadId: threadId,
          taskId,
          observedByRunId: runId,
        });

        const firstAckTask = firstAck.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        const secondAckTask = secondAck.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        assert.isDefined(firstAckTask);
        assert.isDefined(secondAckTask);
        if (
          firstAckTask?.event.type !== "subagent.updated" ||
          secondAckTask?.event.type !== "subagent.updated"
        ) {
          return yield* Effect.die(new Error("Acknowledge events missing."));
        }
        assert.equal(firstAckTask.event.payload.completionDelivery?.state, "acknowledged");
        assert.equal(secondAckTask.event.payload.completionDelivery?.state, "acknowledged");
        // Idempotent replay keeps the first observation's ownership and timestamp.
        assert.deepEqual(
          secondAckTask.event.payload.completionDelivery,
          firstAckTask.event.payload.completionDelivery,
        );
        assert.deepEqual(
          secondAckTask.event.payload.updatedAt,
          firstAckTask.event.payload.updatedAt,
        );
        assert.equal(secondAck.storedEvents.length, 1);

        const afterAck = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          afterAck.subagents.find((candidate) => candidate.id === taskId)?.completionDelivery,
          {
            state: "acknowledged",
            observedByRunId: runId,
          },
        );

        const firstDispose = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.dispose",
          commandId: CommandId.make("command:delegated-delivery-a2:dispose-task-status"),
          parentThreadId: threadId,
          taskId,
        });
        const secondDispose = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.dispose",
          commandId: CommandId.make("command:delegated-delivery-a2:dispose-thread-read"),
          parentThreadId: threadId,
          taskId,
        });

        const firstDisposeTask = firstDispose.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        const secondDisposeTask = secondDispose.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        assert.isDefined(firstDisposeTask);
        assert.isDefined(secondDisposeTask);
        if (
          firstDisposeTask?.event.type !== "subagent.updated" ||
          secondDisposeTask?.event.type !== "subagent.updated"
        ) {
          return yield* Effect.die(new Error("Dispose events missing."));
        }
        assert.equal(firstDisposeTask.event.payload.completionDelivery?.state, "disposed");
        assert.equal(secondDisposeTask.event.payload.completionDelivery?.state, "disposed");
        assert.deepEqual(
          secondDisposeTask.event.payload.completionDelivery,
          firstDisposeTask.event.payload.completionDelivery,
        );
        assert.equal(secondDispose.storedEvents.length, 1);

        const afterDispose = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          afterDispose.subagents.find((candidate) => candidate.id === taskId)?.completionDelivery,
          {
            state: "disposed",
            observedByRunId: null,
          },
        );

        const acknowledgeAfterDispose = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make("command:delegated-delivery-a2:ack-after-dispose"),
          parentThreadId: threadId,
          taskId,
          observedByRunId: runId,
        });
        const acknowledgedTask = acknowledgeAfterDispose.storedEvents.find(
          (stored) => stored.event.type === "subagent.updated",
        );
        if (acknowledgedTask?.event.type !== "subagent.updated") {
          return yield* Effect.die(new Error("Acknowledge-after-dispose event missing."));
        }
        assert.deepEqual(acknowledgedTask.event.payload.completionDelivery, {
          state: "disposed",
          observedByRunId: null,
        });
        assert.equal(acknowledgeAfterDispose.storedEvents.length, 1);

        const afterStaleAcknowledge = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          afterStaleAcknowledge.subagents.find((candidate) => candidate.id === taskId)
            ?.completionDelivery,
          {
            state: "disposed",
            observedByRunId: null,
          },
        );
      }),
  );
});

// Runtime reconciliation writes restart cancellations under this command
// prefix, which the live terminal-run listener skips.
// Collects the SQL text of every statement run under the returned tracer.
const traceSqlStatements = () => {
  const statements: Array<string> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        const query = span.attributes.get("db.query.text");
        if (typeof query === "string") statements.push(query);
      };
      return span;
    },
  });
  return { statements, tracer };
};

const reconcileCommandId = (name: string) => CommandId.make(`command:runtime-reconcile:${name}`);

/**
 * A task's delivery record, without the display activity a later run on its child adds.
 * That activity is refreshed from the event stream, so it lands at no fixed moment.
 */
const deliveryRecord = <T extends { readonly childActivity?: unknown }>(task: T) => {
  const { childActivity: _childActivity, ...record } = task;
  return record;
};

const parentProviderThreadId = (threadId: ThreadId) =>
  ProviderThreadId.make(`provider-thread:${String(threadId).replace("thread:", "")}`);

const runEvent = (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly ordinal: number;
  readonly status: OrchestrationV2Run["status"];
  readonly now: DateTime.Utc;
  readonly providerThreadId?: ProviderThreadId;
  readonly userMessageId?: MessageId;
  readonly delegatedCompletion?: OrchestrationV2Run["delegatedCompletion"];
}) => ({
  id: EventId.make(`event:${input.runId}:${input.status}`),
  type: "run.updated" as const,
  threadId: input.threadId,
  runId: input.runId,
  providerInstanceId: modelSelection.instanceId,
  occurredAt: input.now,
  payload: {
    id: input.runId,
    threadId: input.threadId,
    ordinal: input.ordinal,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId: input.providerThreadId ?? null,
    userMessageId: input.userMessageId ?? MessageId.make(`message:${input.runId}`),
    rootNodeId: null,
    activeAttemptId: null,
    status: input.status,
    requestedAt: input.now,
    startedAt: input.now,
    completedAt: input.status === "running" ? null : input.now,
    checkpointId: null,
    contextHandoffId: null,
    ...(input.delegatedCompletion === undefined
      ? {}
      : { delegatedCompletion: input.delegatedCompletion }),
  },
});

/** A running app-owned task whose child thread's first run the restart cancelled. */
const seedRestartCancelledChild = (input: {
  readonly parentThreadId: ThreadId;
  readonly projectId: ProjectId;
  readonly parentRunId: RunId;
  readonly rootNodeId: NodeId;
  readonly name: string;
  readonly completionWake: "always" | "settled_only";
  readonly continuationPending: boolean;
  /** "completed" seeds a settled turn whose background work the restart cancelled. */
  readonly runStatus?: "cancelled" | "completed";
  /** Background work the restart cancelled on the child's run. */
  readonly lostWork?: OrchestrationV2Run["restartCancelledBackgroundWork"];
  /** The run ended on a quiet spell, so its agent may still continue it by itself. */
  readonly quietEnd?: boolean;
  readonly now: DateTime.Utc;
}) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const taskId = NodeId.make(`node:${input.name}`);
    const childThreadId = ThreadId.make(`thread:${input.name}`);
    const childRunId = RunId.make(`run:${input.name}:1`);
    yield* eventSink.write({
      commandId: CommandId.make(`command:seed-child:${input.name}`),
      events: [
        {
          id: EventId.make(`event:${input.name}:thread`),
          type: "thread.created",
          threadId: childThreadId,
          occurredAt: input.now,
          payload: {
            createdBy: "agent",
            creationSource: "server",
            id: childThreadId,
            projectId: input.projectId,
            title: input.name,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: {
              parentThreadId: input.parentThreadId,
              relationshipToParent: "subagent",
              rootThreadId: input.parentThreadId,
            },
            forkedFrom: { type: "node", nodeId: taskId },
            createdAt: input.now,
            updatedAt: input.now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        },
        {
          id: EventId.make(`event:${input.name}:task`),
          type: "subagent.updated",
          threadId: input.parentThreadId,
          runId: input.parentRunId,
          nodeId: taskId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: taskId,
            threadId: input.parentThreadId,
            runId: input.parentRunId,
            parentNodeId: input.rootNodeId,
            origin: "app_owned",
            createdBy: "agent",
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerThreadId: null,
            childThreadId,
            nativeTaskRef: null,
            prompt: `Run ${input.name}.`,
            title: null,
            model: null,
            completionWake: input.completionWake,
            status: "running",
            result: null,
            startedAt: input.now,
            completedAt: null,
            updatedAt: input.now,
          },
        },
      ],
    });
    const childRun = runEvent({
      threadId: childThreadId,
      runId: childRunId,
      ordinal: 1,
      status: input.runStatus ?? "cancelled",
      now: input.now,
    });
    yield* eventSink.writeWithEffects({
      commandId: reconcileCommandId(input.name),
      events: [
        input.lostWork === undefined
          ? childRun
          : {
              ...childRun,
              payload: { ...childRun.payload, restartCancelledBackgroundWork: input.lostWork },
            },
      ],
      effects: [
        ...(input.continuationPending
          ? [
              {
                id: `effect:restart-continuation:${childRunId}`,
                commandId: reconcileCommandId(input.name),
                threadId: childThreadId,
                request: { type: "provider-runtime.continue" as const, sourceRunId: childRunId },
              },
            ]
          : []),
        ...(input.quietEnd === true
          ? [
              {
                id: `effect:provider-continuation:${childRunId}`,
                commandId: reconcileCommandId(input.name),
                threadId: childThreadId,
                request: { type: "provider-continuation.await" as const, sourceRunId: childRunId },
                availableAt: DateTime.add(input.now, { seconds: 30 }),
              },
            ]
          : []),
      ],
    });
    return { taskId, childThreadId, childRunId };
  });

it.layer(Layer.merge(layerTest, ProviderContinuationRequests.layer))(
  "subagent follow-ups",
  (it) => {
    it.effect("recovers a reserved delivery without loading conversation history", () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:bounded-delivery-recovery");
        const runId = RunId.make("run:bounded-delivery-recovery");
        const taskId = NodeId.make("task:bounded-delivery-recovery");
        yield* seedParentWithTerminalTask({
          threadId,
          runId,
          taskId,
          projectId: ProjectId.make("project:bounded-delivery-recovery"),
          rootNodeId: NodeId.make("node:bounded-delivery-recovery"),
          deliveryState: "claimed",
          deliveryTaskIds: [taskId],
          completionWake: "always",
          now,
        });
        for (const suffix of ["first", "second"]) {
          yield* sink.write({
            events: [
              {
                id: EventId.make(`event:bounded-delivery-history:${suffix}`),
                type: "message.updated",
                threadId,
                occurredAt: now,
                payload: {
                  id: MessageId.make(`message:bounded-delivery-history:${suffix}`),
                  threadId,
                  runId: null,
                  nodeId: null,
                  createdBy: "user",
                  creationSource: "web",
                  role: "user",
                  text: "Unrelated historical input",
                  attachments: [],
                  streaming: false,
                  createdAt: now,
                  updatedAt: now,
                },
              },
            ],
          });
        }
        const statements: string[] = [];
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            const end = span.end.bind(span);
            span.end = (time, exit) => {
              end(time, exit);
              const query = span.attributes.get("db.query.text");
              if (typeof query === "string") statements.push(query);
            };
            return span;
          },
        });
        yield* orchestrator.recoverDelegatedTasks.pipe(Effect.withTracer(tracer));
        assert.isFalse(statements.some((query) => query.includes("MIN(ordinal)")));
        const messageReads = statements.filter((query) =>
          query.includes("FROM orchestration_v2_projection_messages"),
        );
        assert.isNotEmpty(messageReads);
        assert.isTrue(messageReads.every((query) => query.includes("message_id IN")));
        const wake = yield* requests.take;
        assert.equal(wake.delegatedCompletion?.parentRunId, runId);
      }),
    );
    const outcomes = [
      "completed",
      "failed",
      "interrupted",
      "restarted",
      "stopped",
      "overlapping",
      "unbound",
    ] as const;
    it.effect.each(outcomes)(
      "delivers a %s follow-up independently of the original task",
      (outcome) =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          const now = yield* DateTime.now;
          const parentThreadId = ThreadId.make(`thread:followup-${outcome}`);
          const projectId = ProjectId.make(`project:followup-${outcome}`);
          const parentRunId = RunId.make(`run:followup-${outcome}`);
          const rootNodeId = NodeId.make(`node:followup-${outcome}`);
          yield* seedParentWithTerminalTask({
            threadId: parentThreadId,
            projectId,
            runId: parentRunId,
            rootNodeId,
            taskId: NodeId.make(`node:seed-${outcome}`),
            deliveryState: "acknowledged",
            now,
          });
          const child = yield* seedRestartCancelledChild({
            parentThreadId,
            projectId,
            parentRunId,
            rootNodeId,
            name: `followup-child-${outcome}`,
            completionWake: "always",
            continuationPending: false,
            runStatus: "completed",
            now,
          });
          yield* orchestrator.recoverDelegatedTasks;
          let firstWake = yield* requests.take;
          while (firstWake.threadId !== parentThreadId) firstWake = yield* requests.take;
          assert.equal(firstWake.delegatedCompletion?.parentRunId, parentRunId);
          yield* orchestrator.dispatch({
            type: "delegated_task.completion-delivery.acknowledge",
            commandId: CommandId.make(`command:followup-ack-${outcome}`),
            parentThreadId,
            taskId: child.taskId,
            observedByRunId: parentRunId,
          });
          const original = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
            (task) => task.id === child.taskId,
          )!;
          const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.find(
            (run) => run.id === parentRunId,
          )!;
          yield* eventSink.write({
            commandId: reconcileCommandId(`followup-parent-finished-${outcome}`),
            events: [
              {
                id: EventId.make(`event:followup-parent-finished-${outcome}`),
                type: "run.updated",
                threadId: parentThreadId,
                runId: parentRunId,
                occurredAt: now,
                payload: { ...parentRun, status: "completed", completedAt: now },
              },
            ],
          });
          const messageId = MessageId.make(`message:followup-${outcome}`);
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: outcome === "failed" ? "user" : "agent",
            creationSource: outcome === "failed" ? "web" : "mcp",
            commandId: CommandId.make(`command:followup-send-${outcome}`),
            threadId: child.childThreadId,
            senderThreadId: parentThreadId,
            messageId,
            text: "Check the same work again.",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          });
          const childProjection = yield* orchestrator.getThreadProjection(child.childThreadId);
          let run = childProjection.runs.find((row) => row.userMessageId === messageId)!;
          assert.isDefined(run.delegatedTaskId);
          const workingParent = yield* orchestrator.getShellSnapshot();
          const backgroundTask = workingParent.threads
            .find((thread) => thread.id === parentThreadId)
            ?.pendingBackgroundTasks?.find((task) => task.kind === "subagent");
          assert.equal(backgroundTask?.childThreadId, child.childThreadId);
          if (outcome === "overlapping") {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "mcp",
              commandId: CommandId.make("command:overlapping-followup"),
              threadId: child.childThreadId,
              senderThreadId: parentThreadId,
              messageId: MessageId.make("message:overlapping-followup"),
              text: "Keep working on another follow-up.",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
            });
          }
          if (outcome === "restarted") {
            const cut = { ...run, status: "cancelled" as const, startedAt: now, completedAt: now };
            yield* eventSink.writeWithEffects({
              commandId: reconcileCommandId("followup-restart-cut"),
              events: [
                {
                  id: EventId.make("event:followup-restart-cut"),
                  type: "run.updated",
                  threadId: child.childThreadId,
                  runId: run.id,
                  occurredAt: now,
                  payload: cut,
                },
              ],
              effects: [
                {
                  id: `effect:restart-continuation:${run.id}`,
                  commandId: reconcileCommandId("followup-restart-cut"),
                  threadId: child.childThreadId,
                  request: { type: "provider-runtime.continue", sourceRunId: run.id },
                },
              ],
            });
            yield* orchestrator.recoverDelegatedTasks;
            assert.isNull(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === run.delegatedTaskId,
              )!.result,
            );
            const continuationMessageId = MessageId.make("message:followup-restart-continuation");
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "server",
              commandId: CommandId.make("command:followup-restart-continuation"),
              threadId: child.childThreadId,
              restartContinuationOfRunId: run.id,
              messageId: continuationMessageId,
              text: "Continue where you left off.",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
            });
            const continuation = (yield* orchestrator.getThreadProjection(
              child.childThreadId,
            )).runs.find((row) => row.userMessageId === continuationMessageId)!;
            assert.equal(continuation.delegatedTaskId, run.delegatedTaskId);
            run = continuation;
          }
          if (outcome === "stopped") {
            yield* orchestrator.dispatch({
              type: "thread.stop",
              threadId: parentThreadId,
              commandId: CommandId.make(`command:followup-stop-${outcome}`),
            });
          }
          // Reconciliation skips the live terminal listener; recovery must finish this recorded task.
          yield* eventSink.write({
            commandId: reconcileCommandId(`followup-finish-${outcome}`),
            events: [
              {
                id: EventId.make(`event:followup-finish-${outcome}`),
                type: "run.updated",
                threadId: child.childThreadId,
                runId: run.id,
                occurredAt: now,
                payload: {
                  ...run,
                  status:
                    outcome === "stopped"
                      ? "interrupted"
                      : outcome === "restarted" ||
                          outcome === "overlapping" ||
                          outcome === "unbound"
                        ? "completed"
                        : outcome,
                  startedAt: now,
                  completedAt: now,
                },
              },
            ],
          });
          if (outcome === "unbound") {
            // Runs recorded before the binding survived stale updates lost it.
            const sql = yield* SqlClient.SqlClient;
            yield* sql`
              UPDATE orchestration_v2_projection_runs
              SET payload_json = json_remove(payload_json, '$.delegatedTaskId')
              WHERE run_id = ${run.id}
            `;
          }
          yield* orchestrator.recoverDelegatedTasks;
          const finished = yield* orchestrator.getThreadProjection(parentThreadId);
          assert.deepEqual(
            deliveryRecord(finished.subagents.find((task) => task.id === child.taskId)!),
            deliveryRecord(original),
          );
          const followup = finished.subagents.find((task) => task.id === run.delegatedTaskId)!;
          if (outcome === "overlapping") {
            const later = finished.subagents.find(
              (task) =>
                task.childThreadId === child.childThreadId &&
                task.id !== child.taskId &&
                task.id !== followup.id,
            )!;
            assert.equal(later.status, "pending");
            assert.isNull(later.result);
          }
          assert.equal(
            followup.status,
            outcome === "stopped"
              ? "interrupted"
              : outcome === "restarted" || outcome === "overlapping" || outcome === "unbound"
                ? "completed"
                : outcome,
          );
          assert.equal(
            followup.completionDelivery?.state,
            outcome === "stopped" ? "disposed" : "claimed",
          );
          if (outcome !== "stopped") {
            let wake = yield* requests.take;
            while (
              wake.threadId !== parentThreadId ||
              wake.delegatedCompletion?.messageId === firstWake.delegatedCompletion?.messageId
            ) {
              wake = yield* requests.take;
            }
            assert.equal(wake.delegatedCompletion?.parentRunId, parentRunId);
            assert.notEqual(
              wake.delegatedCompletion?.messageId,
              firstWake.delegatedCompletion?.messageId,
            );
          }
          assert.equal(
            finished.contextTransfers.filter(
              (transfer) =>
                transfer.type === "subagent_result" &&
                transfer.sourceThreadId === child.childThreadId,
            ).length,
            2,
          );
          yield* orchestrator.recoverDelegatedTasks;
          const recovered = yield* orchestrator.getThreadProjection(parentThreadId);
          assert.equal(recovered.contextTransfers.length, finished.contextTransfers.length);
          if (outcome === "completed") {
            const automaticMessageId = MessageId.make("message:followup-automatic-wake");
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "server",
              commandId: CommandId.make("command:followup-automatic-wake"),
              threadId: child.childThreadId,
              messageId: automaticMessageId,
              text: "A monitor reported new output.",
              attachments: [],
              notification: {
                source: { kind: "monitor" },
                outcome: "updated",
                summary: "Monitor updated",
              },
              dispatchMode: { type: "queue_after_active" },
            });
            const automatic = (yield* orchestrator.getThreadProjection(
              child.childThreadId,
            )).runs.find((run) => run.userMessageId === automaticMessageId)!;
            assert.isUndefined(automatic.delegatedTaskId);
            yield* eventSink.write({
              commandId: reconcileCommandId("followup-automatic-finished"),
              events: [
                {
                  id: EventId.make("event:followup-automatic-finished"),
                  type: "run.updated",
                  threadId: child.childThreadId,
                  runId: automatic.id,
                  occurredAt: now,
                  payload: { ...automatic, status: "completed", startedAt: now, completedAt: now },
                },
              ],
            });
            yield* orchestrator.recoverDelegatedTasks;
            const afterAutomatic = yield* orchestrator.getThreadProjection(parentThreadId);
            assert.deepEqual(
              afterAutomatic.subagents.map(deliveryRecord),
              recovered.subagents.map(deliveryRecord),
            );
            assert.equal(afterAutomatic.contextTransfers.length, recovered.contextTransfers.length);
            const control = yield* seedRestartCancelledChild({
              parentThreadId,
              projectId,
              parentRunId,
              rootNodeId,
              name: "followup-control-child",
              completionWake: "always",
              continuationPending: false,
              runStatus: "completed",
              now,
            });
            yield* orchestrator.recoverDelegatedTasks;
            const afterControl = yield* orchestrator.getThreadProjection(parentThreadId);
            assert.equal(
              afterControl.subagents.find((task) => task.id === control.taskId)?.completionDelivery
                ?.state,
              "claimed",
            );
            assert.equal(
              afterControl.contextTransfers.filter(
                (transfer) =>
                  transfer.type === "subagent_result" &&
                  transfer.sourceThreadId === control.childThreadId,
              ).length,
              1,
            );
          }
        }),
    );
  },
);

it.layer(Layer.merge(layerTest, ProviderContinuationRequests.layer))(
  "follow-up nested work",
  (it) => {
    it.effect("a late unobserved read wakes a pending result instead of consuming it", () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:late-read-live");
        const runId = RunId.make("run:late-read-live");
        const taskId = NodeId.make("task:late-read-live");
        yield* seedParentWithTerminalTask({
          threadId,
          projectId: ProjectId.make("project:late-read-live"),
          runId,
          rootNodeId: NodeId.make("root:late-read-live"),
          taskId,
          deliveryState: "pending",
          now,
        });
        const acknowledge = (key: string) =>
          orchestrator.dispatch({
            type: "delegated_task.completion-delivery.acknowledge",
            commandId: CommandId.make(`command:late-read-live:${key}`),
            parentThreadId: threadId,
            taskId,
            observedByRunId: null,
          });
        const before = yield* orchestrator.getThreadProjection(threadId);
        // Nobody read it in a live turn, and the spawning run still holds the result.
        const liveRead = yield* acknowledge("live");
        assert.lengthOf(liveRead.storedEvents, 0);
        const parent = before.runs.find((run) => run.id === runId)!;
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:late-read-live:parent-ended"),
              type: "run.updated",
              threadId,
              runId,
              occurredAt: now,
              payload: { ...parent, status: "completed", completedAt: now },
            },
          ],
        });
        yield* acknowledge("ended");
        const wake = yield* requests.take;
        assert.equal(wake.threadId, threadId);
        assert.equal(wake.delegatedCompletion?.parentRunId, runId);
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          after.subagents.find((task) => task.id === taskId)?.completionDelivery?.state,
          "claimed",
        );
        assert.deepEqual(
          after.runs.find((run) => run.id === runId)?.delegatedCompletion?.delivery?.taskIds,
          [taskId],
        );
        const repeated = yield* acknowledge("repeated");
        assert.lengthOf(repeated.storedEvents, 0);
        yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.dispose",
          commandId: CommandId.make("command:late-read-live:dispose"),
          parentThreadId: threadId,
          taskId,
        });
      }),
    );

    it.effect.each(["nested", "background"] as const)(
      "waits for %s work and publishes the continuation result",
      (kind) =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const sink = yield* EventSink.EventSinkV2;
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          const now = yield* DateTime.now;
          const threadId = ThreadId.make(`thread:followup-wait-${kind}`);
          const projectId = ProjectId.make(`project:followup-wait-${kind}`);
          const runId = RunId.make(`run:followup-wait-${kind}`);
          const rootNodeId = NodeId.make(`node:followup-wait-${kind}`);
          yield* seedParentWithTerminalTask({
            threadId,
            projectId,
            runId,
            rootNodeId,
            taskId: NodeId.make(`node:followup-wait-settled-${kind}`),
            deliveryState: "delivered",
            now,
          });
          const child = yield* seedRestartCancelledChild({
            parentThreadId: threadId,
            projectId,
            parentRunId: runId,
            rootNodeId,
            name: `followup-wait-child-${kind}`,
            completionWake: "always",
            continuationPending: false,
            runStatus: "completed",
            now,
          });
          yield* orchestrator.recoverDelegatedTasks;
          const messageId = MessageId.make(`message:followup-wait-${kind}`);
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "agent",
            creationSource: "mcp",
            commandId: CommandId.make(`command:followup-wait-${kind}`),
            threadId: child.childThreadId,
            senderThreadId: threadId,
            messageId,
            text: "Wait for the remaining work.",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          });
          const controls = yield* orchestrator.getThreadProjection(child.childThreadId);
          const run = controls.runs.find((run) => run.userMessageId === messageId)!;
          const taskId = run.delegatedTaskId!;
          const grandchild =
            kind === "nested"
              ? yield* seedRestartCancelledChild({
                  parentThreadId: child.childThreadId,
                  projectId,
                  parentRunId: run.id,
                  rootNodeId: run.rootNodeId!,
                  name: `followup-wait-grandchild-${kind}`,
                  completionWake: "always",
                  continuationPending: false,
                  runStatus: "completed",
                  now,
                })
              : undefined;
          const providerThread = controls.providerThreads.find(
            (thread) => thread.id === run.providerThreadId,
          )!;
          if (kind === "background") {
            yield* sink.write({
              commandId: reconcileCommandId(`followup-roster-${kind}`),
              events: [
                {
                  id: EventId.make(`event:followup-roster-${kind}`),
                  type: "provider-thread.updated",
                  threadId: child.childThreadId,
                  driver,
                  occurredAt: now,
                  payload: {
                    ...providerThread,
                    pendingBackgroundTasks: [{ taskId: "background", kind: "background_task" }],
                  },
                },
              ],
            });
          }
          yield* sink.write({
            commandId: reconcileCommandId(`followup-root-ended-${kind}`),
            events: [
              {
                id: EventId.make(`event:followup-root-ended-${kind}`),
                type: "run.updated",
                threadId: child.childThreadId,
                runId: run.id,
                occurredAt: now,
                payload: { ...run, status: "completed", startedAt: now, completedAt: now },
              },
            ],
          });
          yield* orchestrator.recoverDelegatedTask(child.childThreadId, run.id);
          const waiting = (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
            (task) => task.id === taskId,
          )!;
          assert.isNull(waiting.result);
          assert.equal(waiting.status, "running");
          assert.isTrue(
            yield* orchestrator.delegatedTaskResultPending(child.childThreadId, taskId),
          );
          if (grandchild !== undefined) {
            yield* orchestrator.recoverDelegatedTask(
              grandchild.childThreadId,
              grandchild.childRunId,
            );
            let request = yield* requests.take;
            while (request.threadId !== child.childThreadId) request = yield* requests.take;
            const delivery = request.delegatedCompletion!;
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "server",
              commandId: CommandId.make(`command:followup-nested-wake-${kind}`),
              threadId: child.childThreadId,
              messageId: delivery.messageId,
              text: "Nested work finished.",
              attachments: [],
              delegatedCompletion: { ...delivery, taskIds: [grandchild.taskId] },
              notification: {
                source: { kind: "delegated_task", taskIds: [grandchild.taskId] },
                outcome: "completed",
                summary: "Finished",
              },
              dispatchMode: { type: "queue_after_active" },
            });
          } else {
            yield* sink.write({
              commandId: reconcileCommandId(`followup-roster-cleared-${kind}`),
              events: [
                {
                  id: EventId.make(`event:followup-roster-cleared-${kind}`),
                  type: "provider-thread.updated",
                  threadId: child.childThreadId,
                  driver,
                  occurredAt: now,
                  payload: { ...providerThread, pendingBackgroundTasks: [] },
                },
              ],
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "provider",
              commandId: CommandId.make(`command:followup-background-wake-${kind}`),
              threadId: child.childThreadId,
              messageId: MessageId.make(`message:followup-background-wake-${kind}`),
              text: "Background work finished.",
              attachments: [],
              notification: {
                source: { kind: "background_task" },
                outcome: "completed",
                summary: "Finished",
              },
              dispatchMode: { type: "queue_after_active" },
            });
          }
          const afterWake = yield* orchestrator.getThreadProjection(child.childThreadId);
          const wake = afterWake.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0]!;
          assert.notEqual(wake.id, run.id);
          assert.isTrue(
            yield* orchestrator.delegatedTaskResultPending(child.childThreadId, taskId),
          );
          yield* sink.write({
            commandId: reconcileCommandId(`followup-wake-ended-${kind}`),
            events: [
              {
                id: EventId.make(`event:followup-wake-result-${kind}`),
                type: "message.updated",
                threadId: child.childThreadId,
                runId: wake.id,
                occurredAt: now,
                payload: {
                  id: MessageId.make(`message:followup-final-${kind}`),
                  threadId: child.childThreadId,
                  runId: wake.id,
                  nodeId: null,
                  role: "assistant",
                  text: "Final nested result.",
                  attachments: [],
                  streaming: false,
                  createdBy: "agent",
                  creationSource: "provider",
                  createdAt: now,
                  updatedAt: now,
                },
              },
              {
                id: EventId.make(`event:followup-wake-ended-${kind}`),
                type: "run.updated",
                threadId: child.childThreadId,
                runId: wake.id,
                occurredAt: now,
                payload: {
                  ...wake,
                  status: "completed",
                  startedAt: now,
                  completedAt: DateTime.add(now, { seconds: 1 }),
                },
              },
            ],
          });
          // Recovery settles delivery cohorts after child results, so the next pass
          // can publish the task whose final turn consumed this cohort.
          yield* orchestrator.recoverDelegatedTasks;
          yield* orchestrator.recoverDelegatedTasks;
          const finished = (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
            (task) => task.id === taskId,
          )!;
          assert.equal(finished.result, "Final nested result.");
          assert.isFalse(
            yield* orchestrator.delegatedTaskResultPending(child.childThreadId, taskId),
          );
        }),
    );
  },
);

it.effect("holds a child for app monitors and settles when their deliveries drain", () =>
  Effect.gen(function* () {
    let open = true;
    const settled = yield* Queue.unbounded<ThreadId>();
    const monitors = Layer.mock(MonitorService.MonitorService)({
      canDeliver: () => true,
      ownsCwd: () => false,
      hasOpenWork: () => open,
      settled: Stream.fromQueue(settled),
    });
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:app-monitor-parent");
      const projectId = ProjectId.make("project:app-monitor-parent");
      const runId = RunId.make("run:app-monitor-parent");
      const rootNodeId = NodeId.make("node:app-monitor-parent");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:app-monitor-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "app-monitor-child",
        completionWake: "always",
        continuationPending: false,
        runStatus: "completed",
        now,
      });
      yield* orchestrator.recoverDelegatedTasks;
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
          (task) => task.id === child.taskId,
        )?.status,
        "running",
      );
      assert.isTrue(yield* orchestrator.delegatedTaskResultPending(child.childThreadId));
      const afterSequence = yield* sink.latestSequence();
      const finished = yield* sink.stream({ afterSequence, eventType: "subagent.updated" }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "subagent.updated" &&
            stored.event.payload.id === child.taskId &&
            stored.event.payload.status === "completed",
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      open = false;
      yield* Queue.offer(settled, child.childThreadId);
      yield* Fiber.join(finished);
      assert.isFalse(yield* orchestrator.delegatedTaskResultPending(child.childThreadId));
    }).pipe(Effect.provide(layerTest.pipe(Layer.provide(monitors))));
  }).pipe(Effect.scoped),
);

it.layer(layerTest)("delegated tasks whose agent goes on by itself", (it) => {
  // On 2026-11-21 an Antigravity (Gemini 4 Neon) child's held run ended on a quiet spell after
  // "Finalizing the second commit", and agy went on in a new run seconds later. The parent was
  // woken with the unfinished summary and acted on a half-done worktree.
  it.effect("waits for the continuation's result, or settles on the run's own after a grace", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:quiet-parent");
      const projectId = ProjectId.make("project:quiet-parent");
      const runId = RunId.make("run:quiet-parent");
      const rootNodeId = NodeId.make("node:quiet-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:quiet-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = (name: string) =>
        seedRestartCancelledChild({
          parentThreadId: threadId,
          projectId,
          parentRunId: runId,
          rootNodeId,
          name,
          completionWake: "always",
          continuationPending: false,
          runStatus: "completed",
          quietEnd: true,
          now,
        });
      const message = (input: {
        readonly threadId: ThreadId;
        readonly runId: RunId;
        readonly id: string;
        readonly text: string;
        readonly notification?: boolean;
      }) => ({
        id: EventId.make(`event:${input.id}`),
        type: "message.updated" as const,
        threadId: input.threadId,
        runId: input.runId,
        occurredAt: now,
        payload: {
          id: MessageId.make(input.id),
          threadId: input.threadId,
          runId: input.runId,
          nodeId: null,
          role: input.notification === true ? ("user" as const) : ("assistant" as const),
          text: input.text,
          attachments: [],
          streaming: false,
          createdBy: "agent" as const,
          creationSource: input.notification === true ? ("provider" as const) : ("server" as const),
          ...(input.notification === true
            ? {
                notification: {
                  source: { kind: "background_task" as const },
                  outcome: "updated" as const,
                  summary: "A background command finished.",
                },
              }
            : {}),
          createdAt: now,
          updatedAt: now,
        },
      });
      const continued = yield* child("quiet-continued-child");
      const ended = yield* child("quiet-ended-child");
      yield* eventSink.write({
        commandId: CommandId.make("command:quiet-children:replies"),
        events: [
          message({
            threadId: continued.childThreadId,
            runId: continued.childRunId,
            id: "message:quiet-continued-child:interim",
            text: "Finalizing the second commit.",
          }),
          message({
            threadId: ended.childThreadId,
            runId: ended.childRunId,
            id: "message:quiet-ended-child:report",
            text: "Pushed both commits.",
          }),
        ],
      });
      yield* orchestrator.recoverDelegatedTasks;

      const held = yield* orchestrator.getThreadProjection(threadId);
      for (const { taskId, childThreadId } of [continued, ended]) {
        const task = held.subagents.find((row) => row.id === taskId);
        assert.equal(task?.status, "running");
        assert.isNull(task?.result ?? null);
        assert.isTrue(yield* orchestrator.delegatedTaskResultPending(childThreadId));
      }

      // agy goes on in a new run that opens on the finished command's notification.
      const afterSequence = yield* eventSink.latestSequence();
      const continuationRunId = RunId.make("run:quiet-continued-child:2");
      const notificationId = "message:quiet-continued-child:wake";
      yield* eventSink.write({
        commandId: CommandId.make("command:quiet-continued-child:continued"),
        events: [
          message({
            threadId: continued.childThreadId,
            runId: continuationRunId,
            id: notificationId,
            text: "The background command finished.",
            notification: true,
          }),
          message({
            threadId: continued.childThreadId,
            runId: continuationRunId,
            id: "message:quiet-continued-child:report",
            text: "Both commits are in and the suites pass.",
          }),
          runEvent({
            threadId: continued.childThreadId,
            runId: continuationRunId,
            ordinal: 2,
            status: "completed",
            userMessageId: MessageId.make(notificationId),
            now,
          }),
        ],
      });
      yield* eventSink.stream({ afterSequence, eventType: "subagent.updated" }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "subagent.updated" &&
            stored.event.payload.id === continued.taskId &&
            stored.event.payload.result !== null,
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      const afterContinuation = yield* orchestrator.getThreadProjection(threadId);
      const continuedTask = afterContinuation.subagents.find((row) => row.id === continued.taskId);
      assert.equal(continuedTask?.status, "completed");
      assert.equal(continuedTask?.result, "Both commits are in and the suites pass.");
      assert.isNull(
        afterContinuation.subagents.find((row) => row.id === ended.taskId)?.result ?? null,
      );

      // The other agent never goes on: once the grace passes, its run's own reply is the result.
      yield* TestClock.adjust("30 seconds");
      yield* worker.drain();
      const settled = yield* orchestrator.getThreadProjection(threadId);
      const endedTask = settled.subagents.find((row) => row.id === ended.taskId);
      assert.equal(endedTask?.status, "completed");
      assert.equal(endedTask?.result, "Pushed both commits.");
      assert.isFalse(yield* orchestrator.delegatedTaskResultPending(ended.childThreadId));
    }),
  );

  it.effect(
    "cancels pending provider-continuation grace and settles the child task on thread.stop",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:quiet-stop-parent");
        const runId = RunId.make("run:quiet-stop-parent");
        const rootNodeId = NodeId.make("node:quiet-stop-parent");
        const projectId = ProjectId.make("project:quiet-stop-parent");
        yield* seedParentWithTerminalTask({
          threadId,
          runId,
          taskId: NodeId.make("task:quiet-stop-anchor"),
          projectId,
          rootNodeId,
          deliveryState: "acknowledged",
          deliveryTaskIds: [NodeId.make("task:quiet-stop-anchor")],
          completionWake: "always",
          now,
        });
        const quietChild = yield* seedRestartCancelledChild({
          parentThreadId: threadId,
          projectId,
          parentRunId: runId,
          rootNodeId,
          name: "quiet-stop-child",
          completionWake: "always",
          continuationPending: false,
          runStatus: "completed",
          quietEnd: true,
          now,
        });
        yield* eventSink.write({
          commandId: CommandId.make("command:quiet-stop-child:reply"),
          events: [
            {
              id: EventId.make("event:quiet-stop-child:reply"),
              type: "message.updated" as const,
              threadId: quietChild.childThreadId,
              runId: quietChild.childRunId,
              occurredAt: now,
              payload: {
                id: MessageId.make("message:quiet-stop-child:reply"),
                threadId: quietChild.childThreadId,
                runId: quietChild.childRunId,
                nodeId: null,
                role: "assistant" as const,
                text: "Done with the first pass.",
                attachments: [],
                streaming: false,
                createdBy: "agent" as const,
                creationSource: "server" as const,
                createdAt: now,
                updatedAt: now,
              },
            },
          ],
        });
        yield* orchestrator.recoverDelegatedTasks;
        assert.isTrue(yield* orchestrator.delegatedTaskResultPending(quietChild.childThreadId));

        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("command:quiet-stop-child:stop"),
          threadId: quietChild.childThreadId,
          reason: "Stopped by user.",
        });

        // Without waiting 30s for the grace timer, Stop cancels the continuation wait and settles.
        assert.isFalse(yield* orchestrator.delegatedTaskResultPending(quietChild.childThreadId));
        const parentProjection = yield* orchestrator.getThreadProjection(threadId);
        const task = parentProjection.subagents.find((row) => row.id === quietChild.taskId);
        assert.equal(task?.status, "completed");
        assert.equal(task?.result, "Done with the first pass.");
      }),
  );
});

it.layer(layerTest)("delegated tasks across a server restart", (it) => {
  it.effect("recovers a real task result after a mid-turn monitor steer", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:steered-monitor-parent");
      const projectId = ProjectId.make("project:steered-monitor-parent");
      const runId = RunId.make("run:steered-monitor-parent");
      const rootNodeId = NodeId.make("node:steered-monitor-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:steered-monitor-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "steered-monitor-child",
        completionWake: "always",
        continuationPending: false,
        runStatus: "completed",
        now,
      });
      const run = (yield* orchestrator.getThreadProjection(child.childThreadId)).runs[0]!;
      yield* eventSink.write({
        commandId: reconcileCommandId("steered-monitor-message"),
        events: [
          {
            id: EventId.make("event:steered-monitor-message"),
            type: "message.updated",
            threadId: child.childThreadId,
            runId: run.id,
            occurredAt: now,
            payload: {
              id: MessageId.make("message:steered-monitor-message"),
              threadId: child.childThreadId,
              runId: run.id,
              nodeId: null,
              role: "user",
              text: "Monitor output during real work",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "server",
              createdAt: now,
              updatedAt: now,
              notification: { source: { kind: "monitor" }, outcome: "updated", summary: "Output" },
            },
          },
        ],
      });
      yield* orchestrator.recoverDelegatedTasks;
      const parent = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(parent.subagents.find((task) => task.id === child.taskId)?.status, "completed");
      assert.isTrue(
        parent.contextTransfers.some(
          (transfer) =>
            transfer.type === "subagent_result" && transfer.sourcePoint.runId === run.id,
        ),
      );
    }),
  );

  it.effect(
    "settles a task whose run's result the parent already holds, without a second handover",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:handed-over-parent");
        const projectId = ProjectId.make("project:handed-over-parent");
        const runId = RunId.make("run:handed-over-parent");
        const rootNodeId = NodeId.make("node:handed-over-parent-root");
        yield* seedParentWithTerminalTask({
          threadId,
          projectId,
          runId,
          rootNodeId,
          taskId: NodeId.make("node:handed-over-parent-settled"),
          deliveryState: "delivered",
          now,
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId: threadId,
          projectId,
          parentRunId: runId,
          rootNodeId,
          name: "handed-over-child",
          completionWake: "always",
          continuationPending: false,
          runStatus: "completed",
          now,
        });
        yield* orchestrator.recoverDelegatedTasks;
        const settled = yield* orchestrator.getThreadProjection(threadId);
        const task = settled.subagents.find((candidate) => candidate.id === child.taskId)!;
        assert.equal(task.status, "completed");

        // The result was handed over, but the task's own record still reads
        // running: a follow-up that shares the run, or a write lost in between.
        // Its run is bound to it, as a follow-up's is, which flags it for recovery.
        const childRun = (yield* orchestrator.getThreadProjection(child.childThreadId)).runs[0]!;
        yield* eventSink.write({
          commandId: reconcileCommandId("handed-over-reopened"),
          events: [
            {
              id: EventId.make("event:handed-over-bound-run"),
              type: "run.updated",
              threadId: child.childThreadId,
              runId: childRun.id,
              providerInstanceId: childRun.providerInstanceId,
              occurredAt: now,
              payload: { ...childRun, delegatedTaskId: child.taskId },
            },
            {
              id: EventId.make("event:handed-over-reopened"),
              type: "subagent.updated",
              threadId,
              ...(task.runId === null ? {} : { runId: task.runId }),
              nodeId: task.id,
              driver: task.driver,
              occurredAt: now,
              payload: { ...task, status: "running", result: null, completedAt: null },
            },
          ],
        });
        yield* orchestrator.recoverDelegatedTasks;

        const parent = yield* orchestrator.getThreadProjection(threadId);
        const recovered = parent.subagents.find((candidate) => candidate.id === child.taskId)!;
        assert.equal(recovered.status, "completed");
        assert.isNotNull(recovered.result);
        assert.equal(
          parent.contextTransfers.filter(
            (transfer) =>
              transfer.type === "subagent_result" &&
              transfer.sourceThreadId === child.childThreadId,
          ).length,
          1,
        );
      }),
  );

  it.effect("holds a restart-cancelled child for its continuation's result", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:restart-parent");
      const projectId = ProjectId.make("project:restart-parent");
      const runId = RunId.make("run:restart-parent");
      const rootNodeId = NodeId.make("node:restart-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:restart-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = (
        name: string,
        continuationPending: boolean,
        runStatus?: "cancelled" | "completed",
      ) =>
        seedRestartCancelledChild({
          parentThreadId: threadId,
          projectId,
          parentRunId: runId,
          rootNodeId,
          name,
          completionWake: "always",
          continuationPending,
          ...(runStatus === undefined ? {} : { runStatus }),
          now,
        });
      const resumed = yield* child("restart-resumed-child", true);
      const stopped = yield* child("restart-stopped-child", false);
      // Settled with only background work left: its interim reply is not the result.
      const backgrounded = yield* child("restart-backgrounded-child", true, "completed");
      // A second restart cut the first continuation before it started.
      const recut = yield* child("restart-recut-child", false);
      const recutContinuationId = RunId.make("run:restart-recut-child:2");
      const recutCommandId = CommandId.make("command:restart-recut-child:reconcile");
      const recutRun = runEvent({
        threadId: recut.childThreadId,
        runId: recutContinuationId,
        ordinal: 2,
        status: "cancelled",
        now,
      });
      yield* eventSink.writeWithEffects({
        commandId: recutCommandId,
        events: [
          {
            ...recutRun,
            payload: {
              ...recutRun.payload,
              startedAt: null,
              restartContinuationOfRunId: recut.childRunId,
            },
          },
        ],
        effects: [
          {
            id: `effect:restart-continuation:${recutContinuationId}`,
            commandId: recutCommandId,
            threadId: recut.childThreadId,
            request: { type: "provider-runtime.continue", sourceRunId: recutContinuationId },
          },
        ],
      });

      yield* orchestrator.recoverDelegatedTasks;

      const recovered = yield* orchestrator.getThreadProjection(threadId);
      const task = (id: NodeId) => recovered.subagents.find((row) => row.id === id);
      assert.equal(task(stopped.taskId)?.status, "cancelled");
      assert.equal(task(stopped.taskId)?.completionDelivery?.state, "claimed");
      assert.equal(task(resumed.taskId)?.status, "running");
      assert.isNull(task(resumed.taskId)?.result ?? null);
      assert.equal(task(backgrounded.taskId)?.status, "running");
      assert.isNull(task(backgrounded.taskId)?.result ?? null);
      assert.equal(task(recut.taskId)?.status, "running");
      assert.isTrue(yield* orchestrator.delegatedTaskResultPending(recut.childThreadId));
      assert.isTrue(yield* orchestrator.delegatedTaskResultPending(resumed.childThreadId));
      assert.isFalse(yield* orchestrator.delegatedTaskResultPending(stopped.childThreadId));
      // A replayed first continuation settling must not release the second one's hold.
      yield* orchestrator.recoverDelegatedTask(recut.childThreadId, recut.childRunId);
      const replayed = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(replayed.subagents.find((row) => row.id === recut.taskId)?.status, "running");
      // A caller that read the cancelled run before the child resumed sees it as pending.
      yield* eventSink.write({
        commandId: CommandId.make("command:restart-stopped-child:resumed"),
        events: [
          runEvent({
            threadId: stopped.childThreadId,
            runId: RunId.make("run:restart-stopped-child:2"),
            ordinal: 2,
            status: "running",
            now,
          }),
        ],
      });
      assert.isTrue(yield* orchestrator.delegatedTaskResultPending(stopped.childThreadId));
      assert.isFalse(
        recovered.contextTransfers.some(
          (transfer) => transfer.sourceThreadId === resumed.childThreadId,
        ),
      );

      // The continuation's own run finishing settles the task with its result.
      const afterSequence = yield* eventSink.latestSequence();
      const continuationRunId = RunId.make("run:restart-resumed-child:2");
      yield* eventSink.write({
        commandId: CommandId.make("command:restart-resumed-child:completed"),
        events: [
          {
            id: EventId.make("event:restart-resumed-child:result"),
            type: "message.updated",
            threadId: resumed.childThreadId,
            runId: continuationRunId,
            occurredAt: now,
            payload: {
              id: MessageId.make("message:restart-resumed-child:result"),
              threadId: resumed.childThreadId,
              runId: continuationRunId,
              nodeId: null,
              role: "assistant",
              text: "Finished after the restart.",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "server",
              createdAt: now,
              updatedAt: now,
            },
          },
          runEvent({
            threadId: resumed.childThreadId,
            runId: continuationRunId,
            ordinal: 2,
            status: "completed",
            now,
          }),
        ],
      });
      const settled = yield* eventSink
        .stream({ afterSequence, eventType: "subagent.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" &&
              stored.event.payload.id === resumed.taskId,
          ),
          Stream.take(1),
          Stream.runHead,
        );
      assert.isTrue(settled._tag === "Some");
      const finished = yield* orchestrator.getThreadProjection(threadId);
      const finishedTask = finished.subagents.find((row) => row.id === resumed.taskId);
      assert.equal(finishedTask?.status, "completed");
      assert.equal(finishedTask?.result, "Finished after the restart.");
    }),
  );

  it.effect(
    "starts a child cut during workspace setup again instead of reporting it cancelled",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:restart-setup-parent");
        const projectId = ProjectId.make("project:restart-setup-parent");
        const runId = RunId.make("run:restart-setup-parent");
        const rootNodeId = NodeId.make("node:restart-setup-parent-root");
        yield* seedParentWithTerminalTask({
          threadId,
          projectId,
          runId,
          rootNodeId,
          taskId: NodeId.make("node:restart-setup-parent-settled"),
          deliveryState: "delivered",
          now,
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId: threadId,
          projectId,
          parentRunId: runId,
          rootNodeId,
          name: "restart-setup-child",
          completionWake: "always",
          continuationPending: true,
          now,
        });
        // As recorded: the run never started; the restart cancelled it and its
        // workspace preparation while the setup script ran.
        const cut = (yield* orchestrator.getThreadProjection(child.childThreadId)).runs[0]!;
        const workspacePreparation = {
          type: "worktree" as const,
          baseRef: "c3ab362681",
          startFromOrigin: false,
        };
        yield* eventSink.write({
          commandId: reconcileCommandId("restart-setup-child:records"),
          events: [
            {
              id: EventId.make("event:restart-setup-child:never-started"),
              type: "run.updated",
              threadId: child.childThreadId,
              runId: cut.id,
              providerInstanceId: cut.providerInstanceId,
              occurredAt: now,
              payload: { ...cut, startedAt: null, workspacePreparation },
            },
            {
              id: EventId.make("event:restart-setup-child:task-message"),
              type: "message.updated",
              threadId: child.childThreadId,
              runId: cut.id,
              occurredAt: now,
              payload: {
                id: cut.userMessageId,
                threadId: child.childThreadId,
                runId: cut.id,
                nodeId: null,
                role: "user",
                text: "Goal: fix the failing check.",
                attachments: [],
                streaming: false,
                createdBy: "agent",
                creationSource: "mcp",
                createdAt: now,
                updatedAt: now,
              },
            },
            {
              id: EventId.make("event:restart-setup-child:preparation"),
              type: "turn-item.updated",
              threadId: child.childThreadId,
              runId: cut.id,
              occurredAt: now,
              payload: {
                id: TurnItemId.make("turn-item:restart-setup-child:preparation"),
                threadId: child.childThreadId,
                runId: cut.id,
                nodeId: null,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 2,
                status: "cancelled",
                title: "Starting setup script",
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "command_execution",
                input: "Preparing workspace",
              },
            },
          ],
        });
        yield* orchestrator.recoverDelegatedTasks;

        yield* continueRestartedRun({
          threadId: child.childThreadId,
          sourceRunId: child.childRunId,
        }).pipe(
          Effect.provide(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true })),
        );

        const restarted = yield* orchestrator.getThreadProjection(child.childThreadId);
        const again = restarted.runs.find((run) => run.restartContinuationOfRunId === cut.id);
        assert.equal(again?.status, "preparing");
        assert.deepEqual(again?.workspacePreparation, workspacePreparation);
        assert.equal(
          restarted.messages.find((message) => message.id === again?.userMessageId)?.text,
          "Goal: fix the failing check.",
        );
        yield* orchestrator.recoverDelegatedTasks;
        const parent = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(parent.subagents.find((row) => row.id === child.taskId)?.status, "running");
        assert.isTrue(yield* orchestrator.delegatedTaskResultPending(child.childThreadId));
      }),
  );

  it.effect("settles a restart-cancelled child whose continuation declines to start", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:restart-declined-parent");
      const projectId = ProjectId.make("project:restart-declined-parent");
      const runId = RunId.make("run:restart-declined-parent");
      const rootNodeId = NodeId.make("node:restart-declined-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:restart-declined-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "restart-declined-child",
        completionWake: "always",
        continuationPending: true,
        now,
      });
      yield* orchestrator.recoverDelegatedTasks;
      const held = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(held.subagents.find((row) => row.id === child.taskId)?.status, "running");

      yield* continueRestartedRun({
        threadId: child.childThreadId,
        sourceRunId: child.childRunId,
      }).pipe(
        Effect.provide(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: false })),
      );

      const settled = yield* orchestrator.getThreadProjection(threadId);
      const task = settled.subagents.find((row) => row.id === child.taskId);
      assert.equal(task?.status, "cancelled");
      assert.equal(task?.completionDelivery?.state, "claimed");
    }),
  );

  it.effect("reports a child whose monitor the restart cut as interrupted, not completed", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:restart-monitor-parent");
      const projectId = ProjectId.make("project:restart-monitor-parent");
      const runId = RunId.make("run:restart-monitor-parent");
      const rootNodeId = NodeId.make("node:restart-monitor-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:restart-monitor-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      // The child ended its turn to wait on a gate monitor; the restart cut it.
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "restart-monitor-child",
        completionWake: "always",
        continuationPending: true,
        runStatus: "completed",
        lostWork: [{ kind: "monitor", label: "Gate attempt 9" }],
        now,
      });
      yield* orchestrator.recoverDelegatedTasks;
      const held = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(held.subagents.find((row) => row.id === child.taskId)?.status, "running");

      // Continuation is off, so the cut run is the outcome. It still goes to the parent.
      yield* continueRestartedRun({
        threadId: child.childThreadId,
        sourceRunId: child.childRunId,
      }).pipe(
        Effect.provide(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: false })),
      );

      const settled = yield* orchestrator.getThreadProjection(threadId);
      const task = settled.subagents.find((row) => row.id === child.taskId);
      assert.equal(task?.status, "interrupted");
      assert.equal(task?.result, "Child task ended with status interrupted.");
      assert.equal(task?.completionDelivery?.state, "claimed");
    }),
  );

  // A running provider turn does not prove the provider consumed the delivery
  // (Claude marks the turn running before it reads the prompt), so a cut
  // delivery is offered again even when a continuation resumes that turn.
  it.effect("re-offers a cut delivery even when a continuation resumes its turn", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const seed = (name: string, continuationPending: boolean) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(`thread:${name}`);
          const runId = RunId.make(`run:${name}`);
          const taskId = NodeId.make(`node:${name}-task`);
          const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
          const deliveryRunId = RunId.make(`run:${name}:delivery`);
          yield* seedParentWithTerminalTask({
            threadId,
            projectId: ProjectId.make(`project:${name}`),
            runId,
            rootNodeId: NodeId.make(`node:${name}-root`),
            taskId,
            deliveryState: "claimed",
            completionWake: "always",
            deliveryTaskIds: [taskId],
            now,
          });
          yield* eventSink.writeWithEffects({
            commandId: reconcileCommandId(name),
            events: [
              {
                id: EventId.make(`event:${name}:delivery-message`),
                type: "message.updated",
                threadId,
                runId: deliveryRunId,
                occurredAt: now,
                payload: {
                  id: messageId,
                  threadId,
                  runId: deliveryRunId,
                  nodeId: null,
                  role: "user",
                  text: `Delegated task ${taskId} reached a terminal state.`,
                  attachments: [],
                  streaming: false,
                  createdBy: "agent",
                  creationSource: "server",
                  createdAt: now,
                  updatedAt: now,
                  delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
                },
              },
              runEvent({
                threadId,
                runId: deliveryRunId,
                ordinal: 2,
                status: "cancelled",
                now,
                providerThreadId: parentProviderThreadId(threadId),
                userMessageId: messageId,
              }),
            ],
            effects: continuationPending
              ? [
                  {
                    id: `effect:restart-continuation:${deliveryRunId}`,
                    commandId: reconcileCommandId(name),
                    threadId,
                    request: { type: "provider-runtime.continue", sourceRunId: deliveryRunId },
                  },
                ]
              : [],
          });
          return { threadId, runId, taskId };
        });
      const cut = yield* seed("delivery-cut", false);
      const resumed = yield* seed("delivery-resumed", true);

      yield* orchestrator.recoverDelegatedTasks;

      for (const seeded of [cut, resumed]) {
        const projection = yield* orchestrator.getThreadProjection(seeded.threadId);
        assert.deepEqual(
          projection.subagents.find((row) => row.id === seeded.taskId)?.completionDelivery?.state,
          "claimed",
        );
        const delivery = projection.runs.find((row) => row.id === seeded.runId)?.delegatedCompletion
          ?.delivery;
        assert.equal(delivery?.generation, 2);
        assert.deepEqual(delivery?.taskIds, [seeded.taskId]);
      }
    }),
  );

  // 2026-11-22: a restart cut a lead 4 minutes into the wake it was answering, and the same
  // result arrived again as a second wake, so the lead redid its review.
  it.effect("does not re-offer a cut delivery the lead already answered", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:delivery-answered");
      const runId = RunId.make("run:delivery-answered");
      const taskId = NodeId.make("node:delivery-answered-task");
      const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
      const deliveryRunId = RunId.make("run:delivery-answered:delivery");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId: ProjectId.make("project:delivery-answered"),
        runId,
        rootNodeId: NodeId.make("node:delivery-answered-root"),
        taskId,
        deliveryState: "claimed",
        completionWake: "always",
        deliveryTaskIds: [taskId],
        now,
      });
      yield* eventSink.writeWithEffects({
        commandId: reconcileCommandId("delivery-answered"),
        events: [
          {
            id: EventId.make("event:delivery-answered:message"),
            type: "message.updated",
            threadId,
            runId: deliveryRunId,
            occurredAt: now,
            payload: {
              id: messageId,
              threadId,
              runId: deliveryRunId,
              nodeId: null,
              role: "user",
              text: `Delegated task ${taskId} reached a terminal state.`,
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "server",
              createdAt: now,
              updatedAt: now,
              delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
            },
          },
          {
            id: EventId.make("event:delivery-answered:reply"),
            type: "turn-item.updated",
            threadId,
            runId: deliveryRunId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make("turn-item:delivery-answered:reply"),
              type: "assistant_message",
              threadId,
              runId: deliveryRunId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "completed",
              title: null,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              messageId: MessageId.make("message:delivery-answered:reply"),
              text: "Reviewing the subagent's diff.",
              streaming: false,
            },
          },
          runEvent({
            threadId,
            runId: deliveryRunId,
            ordinal: 2,
            status: "cancelled",
            now,
            providerThreadId: parentProviderThreadId(threadId),
            userMessageId: messageId,
          }),
        ],
        effects: [
          {
            id: `effect:restart-continuation:${deliveryRunId}`,
            commandId: reconcileCommandId("delivery-answered"),
            threadId,
            request: { type: "provider-runtime.continue", sourceRunId: deliveryRunId },
          },
        ],
      });

      yield* orchestrator.recoverDelegatedTasks;

      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(projection.subagents.find((row) => row.id === taskId)?.completionDelivery, {
        state: "acknowledged",
        observedByRunId: deliveryRunId,
      });
      const cohort = projection.runs.find((row) => row.id === runId)?.delegatedCompletion;
      assert.isNull(cohort?.delivery);
      assert.isUndefined(projection.runs.find((row) => row.ordinal === 3));
    }),
  );

  it.effect.each(["failed", "interrupted"] as const)(
    "carries a %s unread wake to an independent turn without waking the parent again",
    (status) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make(`unread-parent-${status}`);
        const runId = RunId.make(`unread-owner-${status}`);
        const taskId = NodeId.make(`unread-task-${status}`);
        const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
        yield* seedParentWithTerminalTask({
          threadId,
          runId,
          taskId,
          projectId: ProjectId.make(`unread-project-${status}`),
          rootNodeId: NodeId.make(`unread-root-${status}`),
          now,
          deliveryState: "claimed",
          completionWake: "always",
          deliveryTaskIds: [taskId],
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`send-wake-${status}`),
          threadId,
          messageId,
          text: "Child finished",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
          delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
        });
        const before = yield* orchestrator.getThreadProjection(threadId);
        const wake = before.runs.find((run) => run.userMessageId === messageId)!;
        yield* sink.write({
          commandId: reconcileCommandId(`refuse-${status}`),
          events: [
            {
              id: EventId.make(`refused-${status}`),
              type: "run.updated",
              threadId,
              runId: wake.id,
              occurredAt: now,
              payload: { ...wake, completedAt: now, status },
            },
          ],
        });
        yield* orchestrator.recoverDelegatedTasks;
        yield* orchestrator.recoverDelegatedTasks;
        const waiting = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(waiting.subagents[0]?.completionDelivery, {
          state: "pending",
          withNextTurn: true,
          observedByRunId: null,
        });
        assert.isNull(waiting.runs.find((run) => run.id === runId)?.delegatedCompletion?.delivery);
        assert.lengthOf(waiting.runs, before.runs.length);

        const next = runEvent({
          threadId,
          runId: RunId.make(`independent-${status}`),
          ordinal: 3,
          status: "completed",
          now,
        });
        yield* sink.write({
          commandId: reconcileCommandId(`carried-${status}`),
          events: [
            {
              ...next,
              payload: { ...next.payload, carriedTaskIds: [taskId] },
            },
          ],
        });
        yield* orchestrator.recoverDelegatedTasks;
        assert.deepEqual(
          (yield* orchestrator.getThreadProjection(threadId)).subagents[0]?.completionDelivery,
          {
            state: "acknowledged",
            observedByRunId: next.runId,
          },
        );
      }),
  );

  it.effect("settles only the current delivery of a parent with long delivery history", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:delivery-history");
      const runId = RunId.make("run:delivery-history");
      const taskId = NodeId.make("node:delivery-history-task");
      const currentMessageId = MessageId.make(`message:delegated-delivery:${threadId}`);
      const currentRunId = RunId.make("run:delivery-history:current");
      const HISTORY = 40;
      yield* seedParentWithTerminalTask({
        threadId,
        projectId: ProjectId.make("project:delivery-history"),
        runId,
        rootNodeId: NodeId.make("node:delivery-history-root"),
        taskId,
        deliveryState: "claimed",
        completionWake: "always",
        deliveryTaskIds: [taskId],
        now,
      });
      const deliveryMessage = (id: MessageId, deliveryRunId: RunId) => ({
        id: EventId.make(`event:${deliveryRunId}:message`),
        type: "message.updated" as const,
        threadId,
        runId: deliveryRunId,
        occurredAt: now,
        payload: {
          id,
          threadId,
          runId: deliveryRunId,
          nodeId: null,
          role: "user" as const,
          text: `Delegated task ${taskId} reached a terminal state.`,
          attachments: [],
          streaming: false,
          createdBy: "agent" as const,
          creationSource: "server" as const,
          createdAt: now,
          updatedAt: now,
          delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
        },
      });
      // Earlier deliveries that already settled. Each one still owns a
      // delegated message and a terminal run.
      const history = Array.from({ length: HISTORY }, (_, index) => {
        const historyRunId = RunId.make(`run:delivery-history:${index}`);
        const messageId = MessageId.make(`message:delivery-history:${index}`);
        return [
          deliveryMessage(messageId, historyRunId),
          runEvent({
            threadId,
            runId: historyRunId,
            ordinal: index + 2,
            status: "completed",
            now,
            providerThreadId: parentProviderThreadId(threadId),
            userMessageId: messageId,
          }),
        ];
      }).flat();
      yield* eventSink.write({
        commandId: reconcileCommandId("delivery-history"),
        events: [
          ...history,
          deliveryMessage(currentMessageId, currentRunId),
          runEvent({
            threadId,
            runId: currentRunId,
            ordinal: HISTORY + 2,
            status: "completed",
            now,
            providerThreadId: parentProviderThreadId(threadId),
            userMessageId: currentMessageId,
          }),
        ],
      });

      const { statements, tracer } = traceSqlStatements();
      yield* orchestrator.recoverDelegatedTasks.pipe(Effect.withTracer(tracer));

      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        projection.subagents.find((row) => row.id === taskId)?.completionDelivery?.state,
        "acknowledged",
      );
      assert.isNull(projection.runs.find((row) => row.id === runId)?.delegatedCompletion?.delivery);
      // Recovery reads the delivery message once, for the current delivery
      // run only. History must not cost one thread reload per past delivery.
      assert.lengthOf(
        statements.filter((statement) =>
          statement.includes("FROM orchestration_v2_projection_messages AS message"),
        ),
        1,
      );

      // A second recovery finds nothing open on this thread and changes nothing.
      yield* orchestrator.recoverDelegatedTasks;
      const again = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(again.runs, projection.runs);
      assert.deepEqual(again.subagents, projection.subagents);
    }),
  );

  it.effect("settles a cancelled child whose held wakes wait behind it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:held-wake-parent");
      const projectId = ProjectId.make("project:held-wake-parent");
      const runId = RunId.make("run:held-wake-parent");
      const rootNodeId = NodeId.make("node:held-wake-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:held-wake-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "held-wake-child",
        completionWake: "always",
        continuationPending: false,
        now,
      });
      // Pull request watch wakes queued while the child ran; the restart held them.
      const held = runEvent({
        threadId: child.childThreadId,
        runId: RunId.make("run:held-wake-child:2"),
        ordinal: 2,
        status: "queued",
        now,
      });
      yield* eventSink.write({
        commandId: CommandId.make("command:held-wake-child:held"),
        events: [
          {
            ...held,
            payload: { ...held.payload, startedAt: null, completedAt: null, queueHeld: true },
          },
        ],
      });

      // Settling this card does not decode cards belonging to older parent runs.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, type, status, ordinal, updated_at, payload_json)
        VALUES ('historical-card', ${threadId}, 'previous-run', 'subagent', 'completed', 1,
          ${DateTime.formatIso(now)}, '{}')`;
      yield* orchestrator.recoverDelegatedTasks;
      yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id = 'historical-card'`;

      const recovered = yield* orchestrator.getThreadProjection(threadId);
      const task = recovered.subagents.find((row) => row.id === child.taskId);
      assert.equal(task?.status, "cancelled");
      assert.isNotNull(task?.result ?? null);
      assert.isTrue(
        recovered.contextTransfers.some(
          (transfer) =>
            transfer.type === "subagent_result" && transfer.sourceThreadId === child.childThreadId,
        ),
      );
      assert.isFalse(yield* orchestrator.delegatedTaskResultPending(child.childThreadId));
      // The held wake stays held for the user to resume or discard.
      const childProjection = yield* orchestrator.getThreadProjection(child.childThreadId);
      assert.deepEqual(
        childProjection.runs.map((run) => [run.status, run.queueHeld ?? false]),
        [
          ["cancelled", false],
          ["queued", true],
        ],
      );
    }),
  );

  it.effect("settles a child whose provider failure holds its queued wakes", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:failed-hold-parent");
      const projectId = ProjectId.make("project:failed-hold-parent");
      const runId = RunId.make("run:failed-hold-parent");
      const rootNodeId = NodeId.make("node:failed-hold-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:failed-hold-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "failed-hold-child",
        completionWake: "always",
        continuationPending: false,
        now,
      });
      // The child is resumed, and a wake queues behind its running turn.
      const activeRun = runEvent({
        threadId: child.childThreadId,
        runId: RunId.make("run:failed-hold-child:2"),
        ordinal: 2,
        status: "running",
        now,
      });
      const queued = runEvent({
        threadId: child.childThreadId,
        runId: RunId.make("run:failed-hold-child:3"),
        ordinal: 3,
        status: "queued",
        now,
      });
      yield* eventSink.write({
        commandId: CommandId.make("command:failed-hold-child:resumed"),
        events: [
          activeRun,
          { ...queued, payload: { ...queued.payload, startedAt: null, completedAt: null } },
        ],
      });
      const afterSequence = yield* eventSink.latestSequence();
      const errorItemId = TurnItemId.make("turn-item:failed-hold-child:error");
      yield* eventSink.write({
        commandId: CommandId.make("command:failed-hold-child:failed"),
        events: [
          {
            id: EventId.make("event:failed-hold-child:error"),
            type: "turn-item.updated",
            threadId: child.childThreadId,
            runId: activeRun.runId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: errorItemId,
              type: "error",
              threadId: child.childThreadId,
              runId: activeRun.runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "failed",
              title: "Provider failure",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              failure: {
                class: "provider_error",
                message: "Provider failed.",
                code: "provider_failed",
                retryable: null,
              },
            },
          },
          {
            ...activeRun,
            id: EventId.make("event:failed-hold-child:failed"),
            payload: { ...activeRun.payload, status: "failed", completedAt: now },
          },
        ],
      });

      // The failure holds the queue, which leaves the failure as the task's result.
      const settled = yield* eventSink
        .stream({ afterSequence, eventType: "subagent.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" && stored.event.payload.id === child.taskId,
          ),
          Stream.take(1),
          Stream.runHead,
        );
      assert.isTrue(settled._tag === "Some");
      const recovered = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(recovered.subagents.find((row) => row.id === child.taskId)?.status, "failed");
      const childProjection = yield* orchestrator.getThreadProjection(child.childThreadId);
      assert.deepEqual(
        childProjection.runs.map((run) => [run.status, run.queueHeld ?? false]),
        [
          ["cancelled", false],
          ["failed", false],
          ["queued", true],
        ],
      );
    }),
  );

  it.effect(
    "recovers an unpublished child failure after its completion delivery was disposed",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:unpublished-failure-parent");
        const projectId = ProjectId.make("project:unpublished-failure-parent");
        const runId = RunId.make("run:unpublished-failure-parent");
        const rootNodeId = NodeId.make("node:unpublished-failure-parent-root");
        yield* seedParentWithTerminalTask({
          threadId,
          projectId,
          runId,
          rootNodeId,
          taskId: NodeId.make("node:unpublished-failure-parent-settled"),
          deliveryState: "delivered",
          now,
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId: threadId,
          projectId,
          parentRunId: runId,
          rootNodeId,
          name: "unpublished-failure-child",
          completionWake: "always",
          continuationPending: false,
          now,
        });
        // Skip the live terminal listener to model a committed failure whose
        // publication was interrupted. task_cancel then disposed its delivery.
        yield* eventSink.write({
          commandId: reconcileCommandId("unpublished-failure"),
          events: [
            runEvent({
              threadId: child.childThreadId,
              runId: child.childRunId,
              ordinal: 1,
              status: "failed",
              now,
            }),
          ],
        });
        yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.dispose",
          commandId: CommandId.make("command:unpublished-failure-dispose"),
          parentThreadId: threadId,
          taskId: child.taskId,
        });
        yield* orchestrator.recoverDelegatedTasks;
        const recovered = yield* orchestrator.getThreadProjection(threadId);
        const task = recovered.subagents.find((row) => row.id === child.taskId);
        assert.equal(task?.status, "failed");
        assert.equal(task?.result, "Child task ended with status failed.");
        assert.equal(task?.completionDelivery?.state, "disposed");
        assert.lengthOf(recovered.runs, 1);
        assert.lengthOf(
          recovered.contextTransfers.filter((transfer) => transfer.type === "subagent_result"),
          1,
        );
        yield* orchestrator.recoverDelegatedTasks;
        assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), recovered);
      }),
  );

  it.effect("wakes the parent for a settled_only task once its spawning turn ended", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:settled-only-restart");
      const projectId = ProjectId.make("project:settled-only-restart");
      const runId = RunId.make("run:settled-only-restart");
      const rootNodeId = NodeId.make("node:settled-only-restart-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:settled-only-restart-settled"),
        deliveryState: "delivered",
        now,
      });
      // The restart cut the turn blocked in delegate_task(wait); its
      // continuation is a new, live run.
      yield* eventSink.write({
        commandId: reconcileCommandId("settled-only-restart"),
        events: [
          runEvent({
            threadId,
            runId,
            ordinal: 1,
            status: "cancelled",
            now,
            providerThreadId: parentProviderThreadId(threadId),
            userMessageId: MessageId.make(`message:seed-user:${threadId}`),
            delegatedCompletion: { disposition: "open", nextGeneration: 2, delivery: null },
          }),
          runEvent({
            threadId,
            runId: RunId.make("run:settled-only-restart:continuation"),
            ordinal: 2,
            status: "running",
            now,
            providerThreadId: parentProviderThreadId(threadId),
          }),
        ],
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "settled-only-restart-child",
        completionWake: "settled_only",
        continuationPending: false,
        now,
      });

      yield* orchestrator.recoverDelegatedTasks;

      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        projection.subagents.find((row) => row.id === child.taskId)?.completionDelivery?.state,
        "claimed",
      );
      assert.deepEqual(
        projection.runs.find((row) => row.id === runId)?.delegatedCompletion?.delivery?.taskIds,
        [child.taskId],
      );
    }),
  );
  it.effect.each(["pending", "acknowledged", "disposed"] as const)(
    "recovers a terminal waited result with %s delivery after the spawning run ended",
    (deliveryState) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make(`waited-terminal-${deliveryState}`);
        const runId = RunId.make(`waited-parent-${deliveryState}`);
        const taskId = NodeId.make(`waited-task-${deliveryState}`);
        yield* seedParentWithTerminalTask({
          threadId,
          runId,
          taskId,
          projectId: ProjectId.make(`waited-project-${deliveryState}`),
          rootNodeId: NodeId.make(`waited-root-${deliveryState}`),
          deliveryState: "acknowledged",
          completionWake: "settled_only",
          now,
        });
        const before = yield* orchestrator.getThreadProjection(threadId);
        yield* sink.write({
          commandId: reconcileCommandId(`terminal-${deliveryState}`),
          events: [
            {
              id: EventId.make(`ended-${deliveryState}`),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: { ...before.runs[0]!, status: "cancelled", completedAt: now },
            },
            {
              id: EventId.make(`unread-${deliveryState}`),
              type: "subagent.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...before.subagents[0]!,
                completionDelivery: { state: deliveryState, observedByRunId: null },
              },
            },
          ],
        });
        yield* orchestrator.recoverDelegatedTasks;
        const after = yield* orchestrator.getThreadProjection(threadId);
        const delivery = after.runs.find((run) => run.id === runId)?.delegatedCompletion?.delivery;
        assert.equal(
          deliveryState === "pending" ? delivery?.taskIds.includes(taskId) : delivery == null,
          true,
        );
        assert.equal(
          after.subagents[0]?.completionDelivery?.state,
          deliveryState === "pending" ? "claimed" : deliveryState,
        );
        yield* orchestrator.recoverDelegatedTasks;
        assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), after);
      }),
  );
});

const childTurnItem = (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly name: string;
  readonly ordinal: number;
  readonly now: DateTime.Utc;
  readonly item:
    | { readonly type: "command_execution"; readonly input: string; readonly exitCode: number }
    | { readonly type: "file_change"; readonly fileName: string };
}) => ({
  id: EventId.make(`event:${input.name}`),
  type: "turn-item.updated" as const,
  threadId: input.threadId,
  runId: input.runId,
  providerInstanceId: modelSelection.instanceId,
  occurredAt: input.now,
  payload: {
    id: TurnItemId.make(`turn-item:${input.name}`),
    threadId: input.threadId,
    runId: input.runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed" as const,
    title: null,
    startedAt: input.now,
    completedAt: input.now,
    updatedAt: input.now,
    ...input.item,
  },
});

it.layer(layerTest)("what a finished task did", (it) => {
  it.effect("records the commands, checks and files the app saw, once", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:seen-parent");
      const projectId = ProjectId.make("project:seen-parent");
      const runId = RunId.make("run:seen-parent");
      const rootNodeId = NodeId.make("node:seen-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:seen-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "seen-child",
        completionWake: "always",
        continuationPending: false,
        now,
      });
      const item = (
        name: string,
        ordinal: number,
        value: Parameters<typeof childTurnItem>[0]["item"],
      ) =>
        childTurnItem({
          threadId: child.childThreadId,
          runId: child.childRunId,
          name,
          ordinal,
          now,
          item: value,
        });
      yield* eventSink.write({
        commandId: reconcileCommandId("seen-child-finished"),
        events: [
          item("seen-lint", 1, { type: "command_execution", input: "vp lint src", exitCode: 1 }),
          item("seen-tsc", 2, {
            type: "command_execution",
            input: "pnpm exec tsc-rs --noEmit",
            exitCode: 0,
          }),
          item("seen-edit", 3, { type: "file_change", fileName: "src/a.ts" }),
          runEvent({
            threadId: child.childThreadId,
            runId: child.childRunId,
            ordinal: 1,
            status: "completed",
            now,
          }),
        ],
      });
      yield* orchestrator.recoverDelegatedTasks;
      const task = (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
        (row) => row.id === child.taskId,
      );
      assert.equal(task?.status, "completed");
      // The project folder is not a Git checkout here, so no commits are listed.
      assert.deepEqual(task?.seen, {
        commands: 2,
        failed: 1,
        failing: ["vp lint src"],
        check: { command: "pnpm exec tsc-rs --noEmit", passed: true },
        files: 1,
      });
      // The lead reads those facts in the completion message itself, not only on request.
      assert.equal(
        delegatedCompletionWakeDetail([child.taskId], [{ ...task!, result: "Report." }]),
        `Subagent ${taskReference(child.taskId)}: completed (${task!.providerInstanceId}/${task!.model ?? "default"})\n` +
          "App saw: check passed: pnpm exec tsc-rs --noEmit; 2 commands; 1 file\nReport.",
      );

      // A stop on the original assignment must not cancel the next one either.
      yield* eventSink.write({
        commandId: reconcileCommandId("seen-child-cancelled"),
        events: [
          {
            id: EventId.make("event:seen-child-cancelled"),
            type: "subagent.updated",
            threadId,
            runId,
            nodeId: child.taskId,
            occurredAt: now,
            payload: { ...task!, status: "cancelled", cancellationRequested: true },
          },
        ],
      });
      const messageId = MessageId.make("message:seen-follow-up");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "agent",
        creationSource: "mcp",
        commandId: CommandId.make("command:seen-follow-up"),
        threadId: child.childThreadId,
        senderThreadId: threadId,
        messageId,
        text: "Check the revised work.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      });
      const followUpRun = (yield* orchestrator.getThreadProjection(child.childThreadId)).runs.find(
        (run) => run.userMessageId === messageId,
      )!;
      assert.isDefined(followUpRun.delegatedTaskId);
      yield* eventSink.write({
        commandId: reconcileCommandId("seen-follow-up-finished"),
        events: [
          childTurnItem({
            threadId: child.childThreadId,
            runId: followUpRun.id,
            name: "seen-follow-up-check",
            ordinal: 1,
            now,
            item: { type: "command_execution", input: "npm test", exitCode: 1 },
          }),
          {
            id: EventId.make("event:seen-follow-up-finished"),
            type: "run.updated",
            threadId: child.childThreadId,
            runId: followUpRun.id,
            occurredAt: now,
            payload: { ...followUpRun, status: "completed", startedAt: now, completedAt: now },
          },
        ],
      });
      yield* orchestrator.recoverDelegatedTasks;
      const followUpTask = (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
        (row) => row.id === followUpRun.delegatedTaskId,
      );
      assert.equal(followUpTask?.status, "completed");
      assert.deepEqual(followUpTask?.seen?.check, { command: "npm test", passed: false });
    }),
  );
});

it.layer(layerTest)("delegated tasks whose wait ends without a run", (it) => {
  /** The child's report for its run, the result its task settles with. */
  const childReport = (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly text: string;
    readonly now: DateTime.Utc;
  }) => ({
    id: EventId.make(`event:report:${input.runId}`),
    type: "message.updated" as const,
    threadId: input.threadId,
    runId: input.runId,
    occurredAt: input.now,
    payload: {
      id: MessageId.make(`message:report:${input.runId}`),
      threadId: input.threadId,
      runId: input.runId,
      nodeId: null,
      role: "assistant" as const,
      text: input.text,
      attachments: [],
      streaming: false,
      createdBy: "agent" as const,
      creationSource: "provider" as const,
      createdAt: input.now,
      updatedAt: input.now,
    },
  });

  /** A child's provider thread, listing the background work its finished turn left running. */
  const childRoster = (input: {
    readonly childThreadId: ThreadId;
    readonly key: string;
    readonly pendingBackgroundTasks: NonNullable<
      OrchestrationV2ProviderThread["pendingBackgroundTasks"]
    >;
    readonly now: DateTime.Utc;
  }) => ({
    commandId: CommandId.make(`command:roster:${input.key}`),
    events: [
      {
        id: EventId.make(`event:roster:${input.key}`),
        type: "provider-thread.updated" as const,
        threadId: input.childThreadId,
        driver,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: input.now,
        payload: {
          id: ProviderThreadId.make(`provider-thread:${input.childThreadId}`),
          driver,
          providerInstanceId: modelSelection.instanceId,
          providerSessionId: null,
          appThreadId: input.childThreadId,
          ownerNodeId: null,
          nativeThreadRef: {
            driver,
            nativeId: `native:${input.childThreadId}`,
            strength: "strong" as const,
          },
          nativeConversationHeadRef: null,
          status: "idle" as const,
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          pendingBackgroundTasks: input.pendingBackgroundTasks,
          createdAt: input.now,
          updatedAt: input.now,
        },
      },
    ],
  });

  /**
   * A parent whose task's child finished its turn and reported, under a parent run whose
   * other task already delivered. The child's run ended in reconciliation, so no live
   * reaction has settled the task yet.
   */
  const seedFinishedChild = (name: string, now: DateTime.Utc) =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make(`thread:${name}`);
      const projectId = ProjectId.make(`project:${name}`);
      const runId = RunId.make(`run:${name}`);
      const rootNodeId = NodeId.make(`node:${name}-root`);
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make(`node:${name}-settled`),
        deliveryState: "delivered",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: `${name}-child`,
        completionWake: "always",
        continuationPending: false,
        runStatus: "completed",
        now,
      });
      yield* eventSink.write({
        commandId: reconcileCommandId(`${name}-report`),
        events: [
          childReport({
            threadId: child.childThreadId,
            runId: child.childRunId,
            text: "Review: no blockers.",
            now,
          }),
        ],
      });
      return { threadId, projectId, runId, ...child };
    });

  /**
   * What the 2026-11-22 cancel left: the parent disposed the task's delivery, the child's
   * work is over, and nothing settled the task, so it still reads running.
   */
  const seedStuckTask = (name: string, now: DateTime.Utc) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const seeded = yield* seedFinishedChild(name, now);
      yield* orchestrator.dispatch({
        type: "delegated_task.completion-delivery.dispose",
        commandId: CommandId.make(`command:${name}:cancel-task-completion-delivery`),
        parentThreadId: seeded.threadId,
        taskId: seeded.taskId,
      });
      const stuck = (yield* orchestrator.getThreadProjection(seeded.threadId)).subagents.find(
        (task) => task.id === seeded.taskId,
      );
      assert.equal(stuck?.status, "running");
      assert.equal(stuck?.completionDelivery?.state, "disposed");
      return seeded;
    });

  const taskRow = (threadId: ThreadId, taskId: NodeId) =>
    Orchestrator.OrchestratorV2.use((orchestrator) =>
      orchestrator
        .getThreadProjection(threadId)
        .pipe(Effect.map((projection) => projection.subagents.find((task) => task.id === taskId))),
    );

  /** Settled with the child's report, and its result wakes nobody. */
  const assertSettledQuietly = (seeded: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly taskId: NodeId;
  }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const parent = yield* orchestrator.getThreadProjection(seeded.threadId);
      const task = parent.subagents.find((row) => row.id === seeded.taskId);
      assert.equal(task?.status, "completed");
      assert.equal(task?.result, "Review: no blockers.");
      assert.equal(task?.completionDelivery?.state, "disposed");
      assert.isFalse(
        parent.runs
          .find((run) => run.id === seeded.runId)
          ?.delegatedCompletion?.delivery?.taskIds.includes(seeded.taskId) ?? false,
      );
    });

  const settledEvent = (taskId: NodeId) =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const afterSequence = yield* eventSink.latestSequence();
      return yield* eventSink.stream({ afterSequence, eventType: "subagent.updated" }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "subagent.updated" &&
            stored.event.payload.id === taskId &&
            stored.event.payload.status === "completed",
        ),
        Stream.runHead,
        Effect.forkChild,
      );
    });

  it.effect("settles a finished task once the Stop ends the background command it waited on", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const seeded = yield* seedFinishedChild("stopped-command", now);
      yield* eventSink.write(
        childRoster({
          childThreadId: seeded.childThreadId,
          key: "stopped-command:running",
          pendingBackgroundTasks: [{ taskId: "bash-1", kind: "command", description: "npm test" }],
          now,
        }),
      );
      yield* orchestrator.recoverDelegatedTasks;
      // The command still runs, so the task waits on it.
      assert.equal((yield* taskRow(seeded.threadId, seeded.taskId))?.status, "running");
      assert.isTrue(yield* orchestrator.delegatedTaskResultPending(seeded.childThreadId));

      // The parent cancels: task_cancel disposes the delivery, and its Stop ends the command.
      yield* orchestrator.dispatch({
        type: "delegated_task.completion-delivery.dispose",
        commandId: CommandId.make("command:stopped-command:dispose"),
        parentThreadId: seeded.threadId,
        taskId: seeded.taskId,
      });
      const settled = yield* settledEvent(seeded.taskId);
      yield* eventSink.write(
        childRoster({
          childThreadId: seeded.childThreadId,
          key: "stopped-command:ended",
          pendingBackgroundTasks: [],
          now,
        }),
      );
      yield* Fiber.join(settled);
      yield* assertSettledQuietly(seeded);
      assert.isFalse(yield* orchestrator.delegatedTaskResultPending(seeded.childThreadId));
    }),
  );

  it.effect("startup recovery settles a task the cancel left reading running", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const seeded = yield* seedStuckTask("stuck-at-startup", yield* DateTime.now);
      yield* orchestrator.recoverDelegatedTasks;
      yield* assertSettledQuietly(seeded);
    }),
  );

  it.effect("a Stop of the idle child settles its stuck task", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const seeded = yield* seedStuckTask("stuck-then-stopped", yield* DateTime.now);
      // The parent's Stop stops each delegated child this way.
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("command:stuck-then-stopped:stop"),
        threadId: seeded.childThreadId,
        stopDelegatedTasks: false,
      });
      yield* assertSettledQuietly(seeded);
    }),
  );

  it.effect("settles a stopped child's task once the task it waited on settles", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const seeded = yield* seedFinishedChild("nested-stop", now);
      // The child delegated work of its own before its turn ended, and waits on it.
      const grandchild = yield* seedRestartCancelledChild({
        parentThreadId: seeded.childThreadId,
        projectId: seeded.projectId,
        parentRunId: seeded.childRunId,
        rootNodeId: NodeId.make("node:nested-stop-child-root"),
        name: "nested-stop-grandchild",
        completionWake: "always",
        continuationPending: false,
        runStatus: "completed",
        now,
      });
      const grandchildRun = runEvent({
        threadId: grandchild.childThreadId,
        runId: grandchild.childRunId,
        ordinal: 1,
        status: "running",
        now,
      });
      yield* eventSink.write({
        commandId: reconcileCommandId("nested-stop-grandchild-running"),
        events: [grandchildRun],
      });
      yield* orchestrator.recoverDelegatedTasks;
      assert.equal((yield* taskRow(seeded.threadId, seeded.taskId))?.status, "running");

      // task_cancel stops the child, then the work under it, which ends without a wake.
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("command:nested-stop:stop-child"),
        threadId: seeded.childThreadId,
        stopDelegatedTasks: false,
      });
      yield* orchestrator.dispatch({
        type: "delegated_task.completion-delivery.dispose",
        commandId: CommandId.make("command:nested-stop:dispose"),
        parentThreadId: seeded.threadId,
        taskId: seeded.taskId,
      });
      assert.equal((yield* taskRow(seeded.threadId, seeded.taskId))?.status, "running");
      const settled = yield* settledEvent(seeded.taskId);
      yield* eventSink.write({
        commandId: CommandId.make("command:nested-stop:grandchild-interrupted"),
        events: [
          {
            ...grandchildRun,
            id: EventId.make("event:nested-stop-grandchild:interrupted"),
            payload: { ...grandchildRun.payload, status: "interrupted", completedAt: now },
          },
        ],
      });
      yield* Fiber.join(settled);
      assert.equal(
        (yield* taskRow(seeded.childThreadId, grandchild.taskId))?.completionDelivery?.state,
        "disposed",
      );
      yield* assertSettledQuietly(seeded);
    }),
  );

  it.effect("a sweep settles a stuck task once its child stayed idle past the grace", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const stuck = yield* seedStuckTask("swept-stuck", now);
      // Another task really waits: its finished child still runs a background command.
      const waiting = yield* seedFinishedChild("swept-waiting", now);
      yield* eventSink.write(
        childRoster({
          childThreadId: waiting.childThreadId,
          key: "swept-waiting",
          pendingBackgroundTasks: [{ taskId: "bash-1", kind: "command", description: "dev" }],
          now,
        }),
      );

      // The worker reads the same database through its own store.
      const sweep = DelegatedTaskReconcileWorker.sweep().pipe(
        Effect.provide(ProjectionStore.layer),
      );
      yield* sweep;
      assert.equal((yield* taskRow(stuck.threadId, stuck.taskId))?.status, "running");

      yield* TestClock.adjust(`${DelegatedTaskReconcileWorker.IDLE_TASK_GRACE_MINUTES} minutes`);
      yield* sweep;
      yield* assertSettledQuietly(stuck);
      assert.equal((yield* taskRow(waiting.threadId, waiting.taskId))?.status, "running");
      assert.isTrue(yield* orchestrator.delegatedTaskResultPending(waiting.childThreadId));
    }),
  );

  // 2026-11-23 to 11-25: three Claude children went on by themselves within a second of
  // their last background command or monitor ending, after their tasks had already
  // settled with the interim reply.
  it.effect("holds a task for the turn its awaited background work starts as it ends", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const now = yield* DateTime.now;
      const seed = (name: string) =>
        Effect.gen(function* () {
          const seeded = yield* seedFinishedChild(name, now);
          yield* eventSink.write(
            childRoster({
              childThreadId: seeded.childThreadId,
              key: `${name}:running`,
              pendingBackgroundTasks: [
                { taskId: "bash-1", kind: "command", description: "npm test", wakesAgent: true },
              ],
              now,
            }),
          );
          yield* eventSink.write(
            childRoster({
              childThreadId: seeded.childThreadId,
              key: `${name}:ended`,
              pendingBackgroundTasks: [],
              now,
            }),
          );
          // Every settle after the roster empties reads this hold.
          const holdId = `effect:provider-continuation:${seeded.childRunId}:background-wake`;
          while (Option.isNone(yield* outbox.get(holdId))) yield* outbox.awaitAvailable;
          return seeded;
        });
      const continued = yield* seed("background-wake-continued");
      const ended = yield* seed("background-wake-ended");

      // One agent goes on: its turn opens on the command's exit, and its report is the result.
      const settled = yield* settledEvent(continued.taskId);
      const nextRunId = RunId.make("run:background-wake-continued:2");
      const wakeId = MessageId.make("message:background-wake-continued:wake");
      yield* eventSink.write({
        commandId: CommandId.make("command:background-wake-continued:2"),
        events: [
          {
            id: EventId.make("event:background-wake-continued:wake"),
            type: "message.updated",
            threadId: continued.childThreadId,
            runId: nextRunId,
            occurredAt: now,
            payload: {
              id: wakeId,
              threadId: continued.childThreadId,
              runId: nextRunId,
              nodeId: null,
              role: "user",
              text: "npm test finished.",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "provider",
              notification: {
                source: { kind: "command" },
                outcome: "completed",
                summary: "npm test finished",
              },
              createdAt: now,
              updatedAt: now,
            },
          },
          childReport({
            threadId: continued.childThreadId,
            runId: nextRunId,
            text: "Tests pass.",
            now,
          }),
          runEvent({
            threadId: continued.childThreadId,
            runId: nextRunId,
            ordinal: 2,
            status: "completed",
            userMessageId: wakeId,
            now,
          }),
        ],
      });
      yield* Fiber.join(settled);
      assert.equal((yield* taskRow(continued.threadId, continued.taskId))?.result, "Tests pass.");

      // The other never does: once the grace passes, its turn's own report is the result.
      assert.equal((yield* taskRow(ended.threadId, ended.taskId))?.status, "running");
      yield* TestClock.adjust("30 seconds");
      yield* worker.drain();
      const endedTask = yield* taskRow(ended.threadId, ended.taskId);
      assert.equal(endedTask?.status, "completed");
      assert.equal(endedTask?.result, "Review: no blockers.");
    }).pipe(
      // The same build shares the orchestrator's outbox, so its wake signal reaches this test.
      Effect.provide(EffectOutbox.layer.pipe(Layer.provideMerge(layerTest))),
      Effect.scoped,
    ),
  );
});
