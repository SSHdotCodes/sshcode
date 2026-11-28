import * as LocalFiles from "../assets/LocalFileAttachments.ts";
import { modelRankingSelectionKey } from "@t3tools/shared/modelRankings";
import { formatOutOfCredit } from "@t3tools/client-runtime/providerHealth";
import * as WorkflowsService from "../workflows/WorkflowsService.ts";
import { byteCount, volume } from "../../../../scripts/lib/agentQuality.ts";
import { writeAgentQualityArtifact } from "../orchestration-v2/testkit/AgentQualityRecorder.ts";
import { ProviderSessionId, RuntimeRequestId } from "@t3tools/contracts";
import * as DelegationModes from "./delegationModes.ts";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as MonitorService from "../monitors/MonitorService.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { assert, describe } from "vite-plus/test";
import {
  CommandId,
  ComposerContextId,
  EventId,
  SecretRef,
  ContextTransferId,
  MessageId,
  EnvironmentId,
  NodeId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  ApiKeyName,
  type OrchestratorMcpCapabilitiesResult,
  type ScheduledTask,
  ScheduledTaskId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ServerSettingsError,
  SubagentRankingsError,
  WorkflowId,
  WorkflowRunId,
  WorkflowsError,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
  type ModelSelection,
  type UsageLimitSourceSnapshot,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as PlatformError from "effect/PlatformError";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import {
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  OrchestratorThreadAboveModeLimitError,
} from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { buildUnavailableProviderSnapshot } from "../provider/unavailableProviderSnapshot.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { resolveTaskReference, taskReference } from "../orchestration-v2/taskReference.ts";
import { SubagentRankings } from "../subagentRankings/SubagentRankings.ts";
import type { RecordedGrade } from "../subagentRankings/records.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const mockProviderRegistry = (overrides: Partial<ProviderRegistry.ProviderRegistry["Service"]>) =>
  Layer.mock(ProviderRegistry.ProviderRegistry)({
    getModelFailures: Effect.succeed(new Map()),
    ...overrides,
  });

const layerNoScratchFolders = Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
  namedProjectsRoot: "/unused",
  folderForThread: () => Effect.succeedNone,
});
const layerOrchestratorMcpWithoutScratch = OrchestratorMcpService.layer.pipe(
  Layer.provide(Layer.mock(LocalFiles.LocalFileAttachments)({})),
  Layer.provide(layerNoScratchFolders),
);
const layerWithProviderStubs = OrchestratorMcpService.layer.pipe(
  Layer.provide(Layer.mock(LocalFiles.LocalFileAttachments)({})),
  Layer.provide(Layer.mock(UsageLimitSources.UsageLimitSources)({ current: Effect.succeed([]) })),
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);
const layerOrchestratorService = layerWithProviderStubs.pipe(Layer.provide(layerNoScratchFolders));

/** A subagent and its idle parent; `sent` records what reaches the parent. */
const makeHeldParentHarness = Effect.gen(function* () {
  const parentThreadId = ThreadId.make("thread:mcp-held-parent");
  const childThreadId = ThreadId.make("thread:mcp-held-child");
  const childShell = liveThreadShell(childThreadId);
  const childProjection: OrchestrationV2ThreadProjection = {
    ...idleThreadProjection(childShell),
    thread: {
      ...idleThreadProjection(childShell).thread,
      title: "sol-moe",
      lineage: {
        rootThreadId: parentThreadId,
        parentThreadId,
        relationshipToParent: "subagent",
      },
    },
    runs: [
      {
        id: RunId.make("run:mcp-held-child"),
        status: "running",
        providerInstanceId: ProviderInstanceId.make("codex"),
        ordinal: 1,
      } as unknown as OrchestrationV2ThreadProjection["runs"][number],
    ],
  };
  const parentShell = liveThreadShell(parentThreadId, { activeRunId: null });
  const parentProjection = idleThreadProjection(parentShell);
  const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
  const failedSends = yield* Ref.make(0);
  const sendError = yield* Ref.make<ThreadManagementService.ThreadManagementError | null>(null);
  const attempts = yield* Queue.unbounded<ThreadManagementService.ThreadManagementSendInput>();
  const accepted = yield* Queue.unbounded<ThreadManagementService.ThreadManagementSendInput>();
  const sent = yield* Ref.make<ReadonlyArray<ThreadManagementService.ThreadManagementSendInput>>(
    [],
  );
  const layerDependencies = Layer.mergeAll(
    NodeServices.layer,
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: (threadId) =>
        Effect.succeed(threadId === childThreadId ? childProjection : parentProjection),
      getThreadShell: () => Effect.succeed(parentShell),
      getProjectThreadRecords: () => Effect.succeed(parentProjection),
      getThreadEventSequence: () => Effect.succeed(0),
      streamStoredEventsFrom: () => Stream.fromQueue(events),
      // The parent is idle, so it has no turn to steer.
      sendToThread: (input) =>
        input.mode === "steer"
          ? Effect.fail(
              new ThreadManagementService.ThreadManagementNoSteerableRunError({
                threadId: input.threadId,
                mode: "steer",
              }),
            )
          : Effect.gen(function* () {
              yield* Queue.offer(attempts, input);
              const permanentError = yield* Ref.get(sendError);
              if (permanentError !== null) {
                return yield* permanentError;
              }
              if ((yield* Ref.get(failedSends)) > 0) {
                yield* Ref.update(failedSends, (count) => count - 1);
                return yield* new ThreadManagementService.ThreadManagementNoSteerableRunError({
                  threadId: input.threadId,
                  mode: "steer",
                });
              }
              yield* Ref.update(sent, (inputs) => [...inputs, input]);
              yield* Queue.offer(accepted, input);
            }).pipe(
              Effect.as({
                message: {
                  id: input.messageId,
                  notifySenderOnCompletion: input.notifySenderOnCompletion,
                },
                run: { id: RunId.make("run:mcp-held-parent"), status: "queued" },
                delivery: "queued",
              } as never),
            ),
    }),
    ServerSettings.layerTest(),
    mockProviderRegistry({ getProviders: Effect.succeed([]) }),
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
      list: () => Effect.succeed([]),
    }),
    Layer.mock(ProjectService.ProjectService)({}),
    Layer.mock(SecretRequests.SecretRequests)({}),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  );
  const childScope: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:mcp-held"),
    requestNamespace: "provider-session:mcp-held-child",
    thread: {
      threadId: childThreadId,
      providerSessionId: "provider-session:mcp-held-child",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };
  return {
    parentThreadId,
    childThreadId,
    childScope,
    events,
    failedSends,
    sendError,
    attempts,
    accepted,
    sent,
    layer: layerOrchestratorService.pipe(Layer.provide(layerDependencies)),
  };
});

describe("OrchestratorMcpService", () => {
  it.effect(
    "holds a subagent's updates for its idle parent and sends them with its next turn",
    () =>
      Effect.gen(function* () {
        const { parentThreadId, childThreadId, childScope, events, sent, accepted, layer } =
          yield* makeHeldParentHarness;

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          for (const [index, message] of ["Kernel exact.", "Kernel at 1.4 TB/s."].entries()) {
            const result = yield* service.sendToThread(childScope, {
              threadId: parentThreadId,
              message,
              clientRequestId: `held-update-${index}`,
            });
            assert.equal(result.delivery, "held");
            assert.isUndefined(result.notice);
            assert.isNull(result.runId);
          }
          // An explicit mode still wakes the parent at once.
          const urgent = yield* service.sendToThread(childScope, {
            threadId: parentThreadId,
            message: "Blocked on the reference fixture.",
            mode: "queue",
            clientRequestId: "held-update-urgent",
          });
          assert.isUndefined(urgent.notice);
          assert.deepEqual(
            (yield* Ref.get(sent)).map((input) => input.text),
            ["Blocked on the reference fixture."],
          );

          yield* Queue.take(accepted);
          // The parent's next running turn takes both held updates as one message.
          yield* Queue.offer(events, {
            sequence: 1,
            commandId: null,
            event: {
              type: "provider-turn.updated",
              threadId: parentThreadId,
              payload: { status: "running" },
            },
          } as unknown as OrchestrationV2StoredEvent);
          const delivery = yield* Queue.take(accepted);
          assert.equal(delivery.threadId, parentThreadId);
          assert.equal(delivery.mode, "auto");
          assert.equal(delivery.senderThreadId, childThreadId);
          assert.equal(
            delivery.text,
            [
              "Your subagents sent 2 updates while you were idle:",
              `From "sol-moe" (thread ${childThreadId}):\nKernel exact.`,
              `From "sol-moe" (thread ${childThreadId}):\nKernel at 1.4 TB/s.`,
            ].join("\n\n"),
          );
          if (process.env.T3_AGENT_QUALITY_DIR)
            yield* Effect.promise(() =>
              writeAgentQualityArtifact(
                "app-message-held-updates",
                volume(byteCount(delivery.text)),
              ),
            );
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect("wakes a parent still idle two minutes after the first held update", () =>
    Effect.gen(function* () {
      const { parentThreadId, childScope, sent, layer } = yield* makeHeldParentHarness;

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.sendToThread(childScope, {
          threadId: parentThreadId,
          message: "Harness definitions ready for core.",
          clientRequestId: "held-update-ready",
        });
        assert.equal(result.delivery, "held");
        yield* Effect.repeat(Effect.yieldNow, { times: 20 });

        yield* TestClock.adjust("119 seconds");
        yield* Effect.repeat(Effect.yieldNow, { times: 20 });
        assert.deepEqual(yield* Ref.get(sent), []);

        yield* TestClock.adjust("1 second");
        yield* Effect.repeat(Ref.get(sent).pipe(Effect.map((inputs) => inputs.length)), {
          until: (count) => count === 1,
        });
        const delivery = (yield* Ref.get(sent))[0]!;
        assert.equal(delivery.threadId, parentThreadId);
        assert.equal(delivery.mode, "auto");
        assert.equal(delivery.text, "Harness definitions ready for core.");
        if (process.env.T3_AGENT_QUALITY_DIR)
          yield* Effect.promise(() =>
            writeAgentQualityArtifact("app-message-idle-wake", volume(byteCount(delivery.text))),
          );
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("does not redeliver one member of an accepted batch on a client retry", () =>
    Effect.gen(function* () {
      const { parentThreadId, childScope, accepted, sent, layer } = yield* makeHeldParentHarness;
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const send = (message: string) =>
          service.sendToThread(childScope, {
            threadId: parentThreadId,
            clientRequestId: message,
            message,
          });
        yield* send("first");
        yield* send("second");
        yield* TestClock.adjust("2 minutes");
        const batch = yield* Queue.take(accepted);
        assert.include(batch.text, "first");
        assert.include(batch.text, "second");
        yield* send("first");
        yield* TestClock.adjust("2 minutes");
        const distinct = new Set((yield* Ref.get(sent)).map((delivery) => delivery.commandId));
        assert.equal(distinct.size, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("retries the same held batch and keeps updates arriving before acceptance", () =>
    Effect.gen(function* () {
      const { parentThreadId, childScope, events, failedSends, attempts, accepted, layer } =
        yield* makeHeldParentHarness;
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        yield* Ref.set(failedSends, 1);
        yield* service.sendToThread(childScope, {
          threadId: parentThreadId,
          message: "First update",
          clientRequestId: "fake-first",
        });
        const event = {
          sequence: 1,
          commandId: null,
          event: {
            type: "provider-turn.updated",
            threadId: parentThreadId,
            payload: { status: "running" },
          },
        } as unknown as OrchestrationV2StoredEvent;
        yield* Queue.offer(events, event);
        const failed = yield* Queue.take(attempts);
        yield* service.sendToThread(childScope, {
          threadId: parentThreadId,
          message: "Later update",
          clientRequestId: "fake-later",
        });
        yield* TestClock.adjust("5 seconds");
        const retried = yield* Queue.take(accepted);
        assert.equal(retried.messageId, failed.messageId);
        assert.equal(retried.commandId, failed.commandId);
        assert.equal(retried.text, "First update");
        yield* Queue.offer(events, event);
        const later = yield* Queue.take(accepted);
        assert.equal(later.text, "Later update");
        assert.notEqual(later.messageId, failed.messageId);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect.each(["archived", "deleted", "disabled"] as const)(
    "stops retrying held subagent updates when the parent thread is %s",
    (state) =>
      Effect.gen(function* () {
        const { parentThreadId, childScope, sendError, attempts, layer } =
          yield* makeHeldParentHarness;
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          yield* service.sendToThread(childScope, {
            threadId: parentThreadId,
            message: "Progress note.",
            clientRequestId: `held-permanent-${state}`,
          });
          yield* Ref.set(
            sendError,
            state === "archived"
              ? new ThreadManagementService.ThreadManagementThreadArchivedError({
                  threadId: parentThreadId,
                })
              : state === "deleted"
                ? new ThreadManagementService.ThreadManagementThreadNotFoundError({
                    projectId: ProjectId.make("project:mcp-held"),
                    threadId: parentThreadId,
                  })
                : new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                    projectId: ProjectId.make("project:mcp-held"),
                    instanceId: ProviderInstanceId.make("codex"),
                  }),
          );
          yield* TestClock.adjust("2 minutes");
          yield* Queue.take(attempts);
          yield* TestClock.adjust("3 minutes");
          assert.equal(yield* Queue.size(attempts), 0);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect("sends a steer as a new turn when the chat's turn already ended", () =>
    Effect.gen(function* () {
      const { parentThreadId, childScope, sent, layer } = yield* makeHeldParentHarness;

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.sendToThread(childScope, {
          threadId: parentThreadId,
          message: "Use the second fixture instead.",
          mode: "steer",
          clientRequestId: "steer-after-end",
        });
        assert.equal(result.runId, RunId.make("run:mcp-held-parent"));
        assert.deepEqual(
          (yield* Ref.get(sent)).map((input) => [input.mode, input.text]),
          [["auto", "Use the second fixture instead."]],
        );
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("reports a child run the provider has not started yet as starting", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-starting-parent");
      const childThreadId = ThreadId.make("thread:mcp-starting-child");
      const childRunId = RunId.make("run:mcp-starting-child");
      const taskId = NodeId.make("node:mcp-starting-task");
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            status: "running",
            result: null,
            completionDelivery: null,
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      let providerStarted = false;
      const childProjection = () =>
        ({
          thread: { id: childThreadId, title: "Child task" },
          runs: [
            {
              id: childRunId,
              ordinal: 1,
              status: providerStarted ? "running" : "starting",
              startedAt: providerStarted ? DateTime.makeUnsafe("2026-10-24T10:00:00Z") : null,
              delegatedTaskId: taskId,
            },
          ],
          contextTransfers: [],
          messages: [],
          subagents: [],
          providerThreads: [{ status: "not_loaded", pendingBackgroundTasks: [] }],
          providerTurns: [],
          runtimeRequests: [],
          turnItems: [],
        }) as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection()),
        }),
        ServerSettings.layerTest(),
        mockProviderRegistry({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-starting"),
        requestNamespace: "provider-session:mcp-starting",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-starting",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const waiting = yield* service.taskStatus(scope, taskId);
        assert.equal(waiting.status, "starting");
        assert.equal(waiting.workState, "working");
        assert.equal(waiting.childRunId, childRunId);
        providerStarted = true;
        const started = yield* service.taskStatus(scope, taskId);
        assert.equal(started.status, "running");
        assert.equal(started.workState, "working");
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("retries terminal acknowledgement with a fresh command id", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-ack-parent");
      const childThreadId = ThreadId.make("thread:mcp-ack-child");
      const childRunId = RunId.make("run:mcp-ack-child");
      const taskId = NodeId.make("node:mcp-ack-task");
      const acknowledgementCommandIds = yield* Ref.make<ReadonlyArray<string>>([]);
      const acknowledgementAttempts = yield* Ref.make(0);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: "terminal result",
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [
          {
            id: childRunId,
            userMessageId: MessageId.make("message:mcp-ack-prompt"),
            ordinal: 1,
            status: "completed",
            startedAt: DateTime.makeUnsafe("2026-10-03T10:00:00Z"),
            completedAt: DateTime.makeUnsafe("2026-10-03T10:10:00Z"),
          },
          {
            id: RunId.make("run:mcp-ack-continuation"),
            ordinal: 2,
            status: "failed",
            startedAt: DateTime.makeUnsafe("2026-10-03T10:02:00Z"),
            completedAt: DateTime.makeUnsafe("2026-10-03T10:05:00Z"),
          },
        ],
        contextTransfers: [],
        messages: [
          {
            id: MessageId.make("message:mcp-ack-monitor-steer"),
            runId: childRunId,
            notification: { source: { kind: "monitor" }, outcome: "updated", summary: "Output" },
          },
        ],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
        turnItems: [],
      } as unknown as OrchestrationV2ThreadProjection;
      let hasNestedWork = true;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? hasNestedWork
                  ? {
                      ...parentProjection,
                      subagents: parentProjection.subagents.map((task) => ({
                        ...task,
                        result: null,
                        status: "running" as const,
                      })),
                    }
                  : parentProjection
                : hasNestedWork
                  ? {
                      ...childProjection,
                      subagents: [
                        { ...parentProjection.subagents[0]!, status: "running" as const },
                      ],
                    }
                  : childProjection,
            ),
          dispatch: (command) =>
            Ref.update(acknowledgementCommandIds, (commandIds) => [
              ...commandIds,
              String(command.commandId),
            ]).pipe(
              Effect.andThen(Ref.updateAndGet(acknowledgementAttempts, (count) => count + 1)),
              Effect.flatMap((attempt) =>
                attempt === 1
                  ? Effect.fail(new Error("simulated acknowledgement failure") as never)
                  : Effect.succeed({} as never),
              ),
            ),
        }),
        ServerSettings.layerTest(),
        mockProviderRegistry({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-ack"),
        requestNamespace: "provider-session:mcp-ack",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-ack",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const pending = yield* service.taskStatus(scope, taskId);
        if (process.env.T3_AGENT_QUALITY_DIR)
          yield* Effect.promise(() =>
            writeAgentQualityArtifact(
              "mcp-result-task-status-running",
              volume(byteCount(JSON.stringify(pending))),
            ),
          );
        assert.equal(pending.status, "running");
        assert.equal(pending.workState, "waiting_for_children");
        assert.isUndefined(pending.summary);
        assert.equal(yield* Ref.get(acknowledgementAttempts), 0);
        hasNestedWork = false;
        const error = yield* service.taskStatus(scope, taskId).pipe(Effect.flip);
        assert.equal(error.code, "orchestration_error");

        const result = yield* service.taskStatus(scope, taskId);
        assert.equal(result.status, "completed");
        if (process.env.T3_AGENT_QUALITY_DIR)
          yield* Effect.promise(() =>
            writeAgentQualityArtifact(
              "mcp-result-task-status-completed",
              volume(byteCount(JSON.stringify(result))),
            ),
          );
        assert.equal(result.summary, "terminal result");
        // Left out because it is the task's own run.
        assert.isUndefined(result.latestTerminalRunId);
        assert.equal(result.latestTerminalStatus, "completed");
        const commandIds = yield* Ref.get(acknowledgementCommandIds);
        assert.equal(commandIds.length, 2);
        assert.notEqual(commandIds[0], commandIds[1]);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("reports a restart-cut child as working until its continuation settles", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-restart-parent");
      const childThreadId = ThreadId.make("thread:mcp-restart-child");
      const taskId = NodeId.make("node:mcp-restart-task");
      const dispatched = yield* Ref.make(0);
      let awaitsRestart = true;
      let readFails = true;
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            status: "running",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      let childProjection = {
        thread: { id: childThreadId },
        runs: [
          {
            id: RunId.make("run:mcp-restart-child"),
            ordinal: 1,
            status: "cancelled",
            delegatedTaskId: taskId,
            startedAt: DateTime.makeUnsafe("2026-10-03T10:00:00Z"),
            completedAt: DateTime.makeUnsafe("2026-10-03T10:05:00Z"),
          },
          // An unrelated later run cannot supply this follow-up's result.
          { id: RunId.make("run:mcp-restart-later"), ordinal: 2, status: "running" },
        ],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
        turnItems: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          recoverDelegatedTask: () => Effect.void,
          delegatedTaskResultPending: () =>
            readFails
              ? Effect.fail(new OrchestratorProjectionError({ threadId: childThreadId }))
              : Effect.succeed(awaitsRestart),
          dispatch: () => Ref.update(dispatched, (count) => count + 1).pipe(Effect.as({} as never)),
        }),
        ServerSettings.layerTest(),
        mockProviderRegistry({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-restart"),
        requestNamespace: "provider-session:mcp-restart",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-restart",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const failed = yield* service.taskStatus(scope, taskId).pipe(Effect.flip);
        assert.equal(failed.code, "orchestration_error");
        assert.equal(yield* Ref.get(dispatched), 0);
        readFails = false;
        const held = yield* service.taskStatus(scope, taskId);
        assert.equal(held.status, "running");
        assert.equal(held.workState, "working");
        assert.isUndefined(held.summary);
        // The cut run has no outcome while its continuation is pending.
        assert.isNotOk(held.latestTerminalRunId);
        assert.isNotOk(held.latestTerminalStatus);
        // Acknowledging the cut run would suppress the real result's wake.
        assert.equal(yield* Ref.get(dispatched), 0);
        awaitsRestart = false;
        const settled = yield* service.taskStatus(scope, taskId);
        assert.equal(settled.status, "cancelled");
        assert.equal(yield* Ref.get(dispatched), 1);
        childProjection = {
          ...childProjection,
          runs: [
            childProjection.runs[0]!,
            {
              ...childProjection.runs[1]!,
              status: "completed",
              restartContinuationOfRunId: childProjection.runs[0]!.id,
            },
          ],
          messages: [
            {
              role: "assistant",
              runId: childProjection.runs[1]!.id,
              text: "Recovered result",
              streaming: false,
              createdAt: DateTime.makeUnsafe(1),
              updatedAt: DateTime.makeUnsafe(1),
            } as unknown as OrchestrationV2ThreadProjection["messages"][number],
          ],
        };
        const recovered = yield* service.taskStatus(scope, taskId);
        assert.equal(recovered.summary, "Recovered result");
        assert.equal(recovered.latestTerminalRunId, childProjection.runs[1]!.id);
        assert.equal(recovered.latestTerminalStatus, "completed");
        assert.isUndefined(recovered.latestTerminalSummary);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect.each(["monitor", "nested", "background"] as const)(
    "keeps task_status waiting for %s work",
    (kind) =>
      Effect.gen(function* () {
        const parentThreadId = ThreadId.make("thread:mcp-monitor-parent");
        const childThreadId = ThreadId.make("thread:mcp-monitor-child");
        const taskId = NodeId.make("node:mcp-monitor");
        const now = DateTime.makeUnsafe("2026-10-03T10:00:00Z");
        let open = true;
        const parent = {
          thread: { id: parentThreadId },
          runs: [],
          contextTransfers: [],
          subagents: [
            {
              id: taskId,
              threadId: parentThreadId,
              childThreadId,
              origin: "app_owned",
              status: "running",
              result: null,
            },
          ],
        } as unknown as OrchestrationV2ThreadProjection;
        const child = {
          thread: { id: childThreadId, forkedFrom: { type: "node", nodeId: taskId } },
          runs: [
            {
              id: RunId.make("run:mcp-monitor"),
              ordinal: 1,
              ...(kind === "monitor" ? {} : { delegatedTaskId: taskId }),
              status: "completed",
              startedAt: now,
              completedAt: now,
            },
          ],
          contextTransfers: [],
          messages: [],
          subagents: [],
          providerThreads: [],
          runtimeRequests: [],
          turnItems: [],
        } as unknown as OrchestrationV2ThreadProjection;
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(MonitorService.MonitorService)({
            canDeliver: () => true,
            ownsCwd: () => false,
            hasOpenWork: () => kind === "monitor" && open,
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (threadId) =>
              Effect.succeed(
                threadId === parentThreadId
                  ? parent
                  : ({
                      ...child,
                      subagents:
                        kind === "nested" && open
                          ? [{ status: "running", runId: child.runs[0]!.id }]
                          : [],
                      providerThreads:
                        kind === "background" && open
                          ? [
                              {
                                pendingBackgroundTasks: [
                                  { taskId: "background", kind: "background_task" },
                                ],
                              },
                            ]
                          : [],
                    } as unknown as OrchestrationV2ThreadProjection),
              ),
            recoverDelegatedTask: () => Effect.void,
            delegatedTaskResultPending: () => Effect.succeed(false),
            dispatch: () => Effect.succeed({} as never),
          }),
          ServerSettings.layerTest(),
          mockProviderRegistry({ getProviders: Effect.succeed([]) }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([]),
          }),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        const scope: McpInvocationScope = {
          environmentId: EnvironmentId.make("environment:mcp-monitor"),
          requestNamespace: "monitor-test",
          thread: {
            threadId: parentThreadId,
            providerSessionId: "monitor-test",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const waiting = yield* service.taskStatus(scope, taskId);
          assert.equal(waiting.status, "running");
          assert.equal(waiting.workState, "waiting_for_children");
          assert.isUndefined(waiting.summary);
          assert.isUndefined(waiting.notice);
          // A second check with nothing changed points at the wake-up instead.
          const again = yield* service.taskStatus(scope, taskId);
          assert.include(again.notice ?? "", "No change since your check");
          open = false;
          const finished = yield* service.taskStatus(scope, taskId);
          assert.equal(finished.status, "completed");
          assert.isUndefined(finished.notice);
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
      }),
  );

  it.effect.each([true, false])(
    "keeps finished task results stable and lists pending questions with legacy spawn transfer %s",
    (withSpawn) =>
      Effect.gen(function* () {
        const parentThreadId = ThreadId.make("thread:recovered-parent");
        const childThreadId = ThreadId.make("thread:recovered-child");
        const originalId = NodeId.make("node:recovered-original");
        const followupId = NodeId.make("node:recovered-followup");
        const now = DateTime.makeUnsafe("2026-10-03T11:00:00Z");
        const originalRunId = RunId.make("run:recovered-original");
        const followupRunId = RunId.make("run:recovered-followup");
        const resultRunId = withSpawn ? RunId.make("run:recovered-continuation") : followupRunId;
        const task = {
          threadId: parentThreadId,
          childThreadId,
          origin: "app_owned",
          status: "completed",
          startedAt: now,
          completionDelivery: { state: "delivered" },
          prompt: "Check the follow-up.",
        };
        const transfer = (sourceRunId: RunId, name: string) => ({
          id: ContextTransferId.make(name),
          type: "subagent_result",
          sourceThreadId: childThreadId,
          targetThreadId: parentThreadId,
          sourcePoint: { runId: sourceRunId },
        });
        const projectId = ProjectId.make("project:recovered");
        const acknowledgements: NodeId[] = [];
        const parent = {
          thread: { id: parentThreadId, projectId },
          runs: [],
          subagents: [
            { ...task, id: originalId, result: "Original result." },
            { ...task, id: followupId, result: "Follow-up result." },
          ],
          contextTransfers: [
            transfer(originalRunId, "result-original"),
            transfer(resultRunId, "result-followup"),
          ],
        } as unknown as OrchestrationV2ThreadProjection;
        const child = {
          thread: {
            ...idleThreadProjection(liveThreadShell(childThreadId)).thread,
            id: childThreadId,
            projectId,
            deletedAt: null,
            lineage: { parentThreadId, relationshipToParent: "subagent" },
            forkedFrom: { type: "node", nodeId: originalId },
          },
          runs: [...new Set([originalRunId, followupRunId, resultRunId])].map((id, index) => ({
            ...(id === resultRunId && id !== followupRunId
              ? { restartContinuationOfRunId: followupRunId }
              : {}),
            id,
            ordinal: index + 1,
            status: "completed",
            modelSelection: liveThreadShell(childThreadId).modelSelection,
            requestedAt: now,
            userMessageId: MessageId.make(`message:${id}`),
            startedAt: now,
            completedAt: DateTime.add(now, { seconds: index }),
          })),
          messages: [
            {
              id: MessageId.make("message:lost-followup"),
              role: "user",
              runId: followupRunId,
              text: task.prompt,
              createdAt: now,
            },
          ],
          contextTransfers: withSpawn
            ? [
                {
                  type: "subagent_spawn",
                  sourceThreadId: parentThreadId,
                  targetThreadId: childThreadId,
                  targetRunId: originalRunId,
                },
              ]
            : [],
          subagents: [],
          providerThreads: [],
          runtimeRequests: [
            {
              id: RuntimeRequestId.make("request:finished-child-question"),
              kind: "user_input",
              status: "pending",
              responseCapability: withSpawn
                ? {
                    type: "live",
                    providerSessionId: ProviderSessionId.make("session:finished-child"),
                  }
                : { type: "message" },
            },
          ],
          turnItems: [
            {
              type: "user_input_request",
              requestId: RuntimeRequestId.make("request:finished-child-question"),
              questions: [{ header: "Choose target" }],
            },
          ],
        } as unknown as OrchestrationV2ThreadProjection;
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (threadId, _fields, filter) =>
              Effect.succeed(
                threadId === parentThreadId
                  ? parent
                  : ({
                      ...child,
                      messages: filter?.messageRoles?.includes("assistant")
                        ? filter.messageRunIds?.includes(resultRunId)
                          ? [
                              {
                                id: MessageId.make("message:recovered-result"),
                                role: "assistant",
                                runId: resultRunId,
                                text: "Follow-up result.",
                                updatedAt: now,
                              },
                            ]
                          : []
                        : child.messages,
                    } as unknown as OrchestrationV2ThreadProjection),
              ),
            getThreadShell: () =>
              Effect.succeed(child.thread as unknown as OrchestrationV2ThreadShell),
            getProjectThreadRecords: () => Effect.succeed(child),
            getTimelinePage: () =>
              Effect.succeed({
                items: [
                  {
                    position: 0,
                    visibility: "local",
                    sourceThreadId: childThreadId,
                    sourceItemId: TurnItemId.make("item:recovered-result"),
                    item: {
                      id: TurnItemId.make("item:recovered-result"),
                      type: "assistant_message",
                      runId: resultRunId,
                      messageId: MessageId.make("message:recovered-result"),
                      text: "Follow-up result.",
                      createdAt: now,
                      updatedAt: now,
                    },
                  },
                ],
                totalItems: 1,
                hasMore: false,
              } as never),
            dispatch: (command) =>
              Effect.sync(() => {
                if (command.type === "delegated_task.completion-delivery.acknowledge")
                  acknowledgements.push(command.taskId);
                return {} as never;
              }),
          }),
          ServerSettings.layerTest(),
          mockProviderRegistry({ getProviders: Effect.succeed([]) }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([]),
          }),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        const scope: McpInvocationScope = {
          environmentId: EnvironmentId.make("environment:recovered"),
          requestNamespace: "recovered-test",
          thread: {
            threadId: parentThreadId,
            providerSessionId: "recovered-test",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const result = yield* service.taskStatus(scope, followupId);
          assert.equal(result.summary, "Follow-up result.");
          assert.equal(result.status, "completed");
          assert.deepEqual(result.pendingRequests, [
            {
              id: RuntimeRequestId.make("request:finished-child-question"),
              kind: "user_input",
              label: "Choose target",
            },
          ]);
          assert.equal(result.hasPendingQuestion, withSpawn ? true : undefined);
          assert.equal(result.childRunId, followupRunId);
          assert.equal(result.resultContextTransferId, ContextTransferId.make("result-followup"));
          const original = yield* service.taskStatus(scope, originalId);
          assert.equal(original.summary, "Original result.");
          assert.equal(original.childRunId, originalRunId);
          assert.equal(original.resultContextTransferId, ContextTransferId.make("result-original"));
          const unresolved = { ...child, messages: [] };
          assert.isUndefined(
            OrchestratorMcpService.delegatedTaskRun(unresolved, parent.subagents[1]!),
          );
          acknowledgements.length = 0;
          const read = yield* service.readThread(scope, { threadId: childThreadId });
          if (process.env.T3_AGENT_QUALITY_DIR)
            yield* Effect.promise(() =>
              writeAgentQualityArtifact(
                `mcp-result-thread-recovered-${withSpawn}`,
                volume(byteCount(JSON.stringify(read))),
              ),
            );
          assert.deepEqual(acknowledgements, [followupId]);
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
      }),
  );

  it.effect("does not dispose delivery when a nonterminal task has no active child run", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-child");
      const taskId = NodeId.make("node:mcp-cancel-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          // The child still runs within the parent's modes.
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.as({} as never),
            ),
        }),
        ServerSettings.layerTest(),
        mockProviderRegistry({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel"),
        requestNamespace: "provider-session:mcp-cancel",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-unstarted-task" })
          .pipe(Effect.flip);
        assert.equal(error.code, "task_not_cancellable");
        assert.deepEqual(yield* Ref.get(dispatched), []);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("does not dispose delivery when the child stop fails", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-failed-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-failed-child");
      const childRunId = RunId.make("run:mcp-cancel-failed-child");
      const taskId = NodeId.make("node:mcp-cancel-failed-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [{ id: childRunId, status: "running" }],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          // The child still runs within the parent's modes.
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                Effect.fail(
                  new OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause: new Error("simulated stop failure"),
                  }) as never,
                ),
              ),
            ),
        }),
        ServerSettings.layerTest(),
        mockProviderRegistry({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-failed"),
        requestNamespace: "provider-session:mcp-cancel-failed",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-failed",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-failed-task" })
          .pipe(Effect.flip);
        assert.equal(error.code, "task_not_cancellable");
        assert.equal(
          error.message,
          `Unable to stop delegated task ${taskId}: simulated stop failure`,
        );
        assert.deepEqual(
          (yield* Ref.get(dispatched)).map((command) => (command as { type: string }).type),
          ["thread.stop"],
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("returns cancel requested when post-stop disposal fails", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-dispose-failed-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-dispose-failed-child");
      const childRunId = RunId.make("run:mcp-cancel-dispose-failed-child");
      const taskId = NodeId.make("node:mcp-cancel-dispose-failed-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [{ id: childRunId, status: "running" }],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          // The child still runs within the parent's modes.
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                command.type === "delegated_task.completion-delivery.dispose"
                  ? Effect.fail(new Error("simulated disposal failure") as never)
                  : Effect.succeed({} as never),
              ),
            ),
          stopDelegatedTasks: () => Effect.void,
        }),
        ServerSettings.layerTest(),
        mockProviderRegistry({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-dispose-failed"),
        requestNamespace: "provider-session:mcp-cancel-dispose-failed",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-dispose-failed",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.cancelTask(scope, {
          taskId: taskReference(taskId),
          clientRequestId: "cancel-dispose-failed-task",
        });
        assert.equal(result.status, "cancel_requested");
        assert.equal(result.taskId, taskReference(taskId));
        assert.deepEqual(
          (yield* Ref.get(dispatched)).map((command) => (command as { type: string }).type),
          ["thread.stop", "delegated_task.completion-delivery.dispose"],
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect.each(["failed", "cancelled"] as const)(
    "cancels a delegated task waiting on an automatic provider retry (%s run)",
    (runStatus) =>
      Effect.gen(function* () {
        const parentThreadId = ThreadId.make(`thread:mcp-cancel-retry-parent:${runStatus}`);
        const childThreadId = ThreadId.make(`thread:mcp-cancel-retry-child:${runStatus}`);
        const childRunId = RunId.make(`run:mcp-cancel-retry-child:${runStatus}`);
        const taskId = NodeId.make(`node:mcp-cancel-retry-task:${runStatus}`);
        const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const parentProjection = {
          thread: { id: parentThreadId },
          runs: [],
          contextTransfers: [],
          subagents: [
            {
              id: taskId,
              threadId: parentThreadId,
              origin: "app_owned",
              childThreadId,
              driver: "codex",
              model: "gpt-5.6-terra",
              status: "running",
              result: null,
              completionDelivery: { state: "pending" },
            },
          ],
        } as unknown as OrchestrationV2ThreadProjection;
        const childProjection = {
          thread: { id: childThreadId },
          runs: [
            {
              id: childRunId,
              ordinal: 1,
              status: runStatus,
              automaticProviderRetry: {
                attempt: 1,
                status: "scheduled",
                scheduledAt: "2099-01-01T00:00:00.000Z",
              },
            },
          ],
          contextTransfers: [],
          messages: [],
          subagents: [],
          providerThreads: [],
          runtimeRequests: [],
        } as unknown as OrchestrationV2ThreadProjection;
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (threadId) =>
              Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
            getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
            dispatch: (command) =>
              Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                Effect.as({} as never),
              ),
            stopDelegatedTasks: () => Effect.void,
          }),
          ServerSettings.layerTest(),
          mockProviderRegistry({ getProviders: Effect.succeed([]) }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([]),
          }),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        const scope: McpInvocationScope = {
          environmentId: EnvironmentId.make("environment:mcp-cancel-retry"),
          requestNamespace: "provider-session:mcp-cancel-retry",
          thread: {
            threadId: parentThreadId,
            providerSessionId: "provider-session:mcp-cancel-retry",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const result = yield* service.cancelTask(scope, {
            taskId: taskReference(taskId),
            clientRequestId: `cancel-retry-task-${runStatus}`,
          });
          assert.equal(result.status, "cancel_requested");
          assert.deepEqual(
            (yield* Ref.get(dispatched)).map((command) => (command as { type: string }).type),
            ["thread.stop", "delegated_task.completion-delivery.dispose"],
          );
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }),
  );

  it.effect("cancels a delegated task during provider continuation grace", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-continuation-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-continuation-child");
      const childRunId = RunId.make("run:mcp-cancel-continuation-child");
      const taskId = NodeId.make("node:mcp-cancel-continuation-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            status: "running",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [
          {
            id: childRunId,
            ordinal: 1,
            status: "completed",
          },
        ],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.as({} as never),
            ),
          stopDelegatedTasks: () => Effect.void,
          delegatedTaskResultPending: () => Effect.succeed(true),
        }),
        ServerSettings.layerTest(),
        mockProviderRegistry({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-continuation"),
        requestNamespace: "provider-session:mcp-cancel-continuation",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-continuation",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.cancelTask(scope, {
          taskId: taskReference(taskId),
          clientRequestId: "cancel-continuation-grace-task",
        });
        assert.equal(result.status, "cancel_requested");
        assert.deepEqual(
          (yield* Ref.get(dispatched)).map((command) => (command as { type: string }).type),
          ["thread.stop", "delegated_task.completion-delivery.dispose"],
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("refuses to cancel a task whose child now runs above the parent's modes", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-dispose-failed-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-dispose-failed-child");
      const childRunId = RunId.make("run:mcp-cancel-dispose-failed-child");
      const taskId = NodeId.make("node:mcp-cancel-dispose-failed-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      // The parent runs Supervised in plan mode.
      const parentProjection = {
        thread: { id: parentThreadId, runtimeMode: "approval-required", interactionMode: "plan" },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [{ id: childRunId, status: "running" }],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          // Its user has since raised the child to full access.
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                command.type === "delegated_task.completion-delivery.dispose"
                  ? Effect.fail(new Error("simulated disposal failure") as never)
                  : Effect.succeed({} as never),
              ),
            ),
          stopDelegatedTasks: () => Effect.void,
        }),
        ServerSettings.layerTest(),
        mockProviderRegistry({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-dispose-failed"),
        requestNamespace: "provider-session:mcp-cancel-dispose-failed",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-dispose-failed",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-above-modes" })
          .pipe(Effect.flip);
        assert.equal(error.code, "runtime_mode_escalation_denied");
        assert.deepEqual(yield* Ref.get(dispatched), []);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  /**
   * A Supervised parent cancels its Supervised child, under which a task
   * now runs at full access. Reports what the cancel did.
   */
  const cancelOverRaisedGrandchild = (child: {
    readonly deleted: boolean;
    /** The grandchild passes the check, and its user raises it before the stop reaches it. */
    readonly raisedDuringStop?: boolean;
  }) =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-grandchild-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-grandchild-child");
      const grandchildThreadId = ThreadId.make("thread:mcp-cancel-grandchild-grandchild");
      const taskId = NodeId.make("node:mcp-cancel-grandchild-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const stoppedBelow = yield* Ref.make(false);
      const appOwnedTask = (id: string, threadId: ThreadId, childId: ThreadId) => ({
        id: NodeId.make(id),
        threadId,
        origin: "app_owned",
        childThreadId: childId,
        driver: "codex",
        model: "gpt-5.6-terra",
        result: null,
        completionDelivery: { state: "pending" },
      });
      // A Supervised parent delegated a Supervised child, which delegated a task of its own.
      const projections = new Map([
        [
          parentThreadId,
          {
            thread: {
              id: parentThreadId,
              runtimeMode: "approval-required",
              interactionMode: "default",
            },
            runs: [],
            contextTransfers: [],
            subagents: [appOwnedTask(taskId, parentThreadId, childThreadId)],
          },
        ],
        [
          childThreadId,
          {
            thread: { id: childThreadId },
            runs: [{ id: RunId.make("run:mcp-cancel-grandchild-child"), status: "running" }],
            contextTransfers: [],
            messages: [],
            subagents: [
              appOwnedTask("node:mcp-cancel-grandchild-below", childThreadId, grandchildThreadId),
            ],
            providerThreads: [],
            runtimeRequests: [],
          },
        ],
        [
          grandchildThreadId,
          {
            thread: { id: grandchildThreadId },
            runs: [],
            contextTransfers: [],
            messages: [],
            subagents: [],
            providerThreads: [],
            runtimeRequests: [],
          },
        ],
      ]) as unknown as ReadonlyMap<ThreadId, OrchestrationV2ThreadProjection>;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) => Effect.succeed(projections.get(threadId)!),
          // The child still runs Supervised; its user has since raised the task under it
          // to full access.
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === grandchildThreadId && child.raisedDuringStop !== true
                ? liveThreadShell(threadId)
                : threadId === childThreadId && child.deleted
                  ? null
                  : liveThreadShell(threadId, { runtimeMode: "approval-required" }),
            ),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.as({} as never),
            ),
          // Stands in for the orchestrator, which finds the grandchild raised
          // under its lock, when the stop runs under the parent's limit.
          stopDelegatedTasks: () =>
            Effect.gen(function* () {
              const limit = yield* DispatchModeLimit;
              if (child.raisedDuringStop === true && limit?.refused !== undefined) {
                const refusal: DispatchModeRefusal = {
                  threadId: grandchildThreadId,
                  mode: "runtime",
                  runtimeMode: "full-access",
                  interactionMode: "default",
                };
                yield* Ref.set(limit.refused, refusal);
                return yield* new OrchestratorThreadAboveModeLimitError({
                  commandId: CommandId.make("stop-grandchild"),
                  threadId: grandchildThreadId,
                  mode: "runtime",
                  runtimeMode: "full-access",
                  interactionMode: "default",
                });
              }
              yield* Ref.set(stoppedBelow, true);
            }),
        }),
        ServerSettings.layerTest(),
        mockProviderRegistry({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-grandchild"),
        requestNamespace: "provider-session:mcp-cancel-grandchild",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-grandchild",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      return yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-grandchild-above-modes" })
          .pipe(Effect.flip);
        return {
          code: error.code,
          dispatched: yield* Ref.get(dispatched),
          stoppedBelow: yield* Ref.get(stoppedBelow),
        };
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    });

  it.effect("refuses to cancel a task when a task under it now runs above the parent's modes", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* cancelOverRaisedGrandchild({ deleted: false }), {
        code: "runtime_mode_escalation_denied",
        dispatched: [],
        stoppedBelow: false,
      });
    }),
  );

  it.effect("reports a task under the child that its user raises while it is being stopped", () =>
    Effect.gen(function* () {
      const outcome = yield* cancelOverRaisedGrandchild({ deleted: false, raisedDuringStop: true });
      assert.equal(outcome.code, "runtime_mode_escalation_denied");
      assert.isFalse(outcome.stoppedBelow);
    }),
  );

  it.effect("checks the tasks under a deleted child before cancelling it", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* cancelOverRaisedGrandchild({ deleted: true }), {
        code: "runtime_mode_escalation_denied",
        dispatched: [],
        stoppedBelow: false,
      });
    }),
  );
});

describe("OrchestratorMcpService provider resolution", () => {
  const parentThreadId = ThreadId.make("thread:mcp-providers-parent");
  const childThreadId = ThreadId.make("thread:mcp-providers-child");
  const parentRunId = RunId.make("run:mcp-providers-parent");
  const parentNodeId = NodeId.make("node:mcp-providers-root");
  const taskId = NodeId.make("node:mcp-providers-task");
  const projectId = ProjectId.make("project:mcp-providers");
  const codexInstanceId = ProviderInstanceId.make("codex");
  const antigravityInstanceId = ProviderInstanceId.make("antigravity");

  const scope: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:mcp-providers"),
    requestNamespace: "provider-session:mcp-providers",
    thread: {
      threadId: parentThreadId,
      providerSessionId: "provider-session:mcp-providers",
      providerInstanceId: codexInstanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };

  const providerSnapshot = (input: {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly model?: string;
    readonly enabled?: boolean;
  }): ServerProvider => ({
    instanceId: input.instanceId,
    driver: input.driver,
    enabled: input.enabled ?? true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-13T00:00:00.000Z",
    models:
      input.model === undefined
        ? []
        : [{ slug: input.model, name: input.model, isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  });

  /** A registry whose probes report the same snapshots it already holds. */
  const providerRegistryLayer = (providers: ReadonlyArray<ServerProvider>) =>
    mockProviderRegistry({
      getProviders: Effect.succeed(providers),
      getProvidersForUsageLimits: () => Effect.succeed(providers),
      refreshInstance: () => Effect.succeed(providers),
    });

  const adapterRegistryLayer = (instanceIds: ReadonlyArray<ProviderInstanceId>) =>
    Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
        list: () => Effect.succeed(instanceIds),
        get: (instanceId) =>
          instanceIds.includes(instanceId)
            ? Effect.succeed({
                instanceId,
              } as unknown as ProviderAdapter.ProviderAdapterV2["Service"])
            : Effect.fail(
                new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
              ),
      }),
    );

  const parentProjection = (
    subagents: ReadonlyArray<unknown>,
    modelSelection: {
      readonly instanceId: ProviderInstanceId;
      readonly model: string;
      readonly options?: ReadonlyArray<{ readonly id: string; readonly value: unknown }>;
    } = { instanceId: codexInstanceId, model: "gpt-5.4" },
  ): OrchestrationV2ThreadProjection =>
    ({
      thread: {
        id: parentThreadId,
        projectId,
        title: "MCP parent",
        createdBy: "user",
        creationSource: "web",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      },
      runs: [
        {
          id: parentRunId,
          ordinal: 1,
          status: "running",
          rootNodeId: parentNodeId,
          providerInstanceId: modelSelection.instanceId,
          modelSelection,
        },
      ],
      contextTransfers: [],
      subagents,
    }) as unknown as OrchestrationV2ThreadProjection;

  const childProjection = {
    thread: { id: childThreadId },
    runs: [],
    contextTransfers: [],
    messages: [],
    subagents: [],
    providerThreads: [],
    runtimeRequests: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;

  it.effect.each([
    {
      name: "scratch",
      parentPath: "/scratch/2026-11-18-parent",
      childPath: "/scratch/2026-11-18-child",
      branch: null,
    },
    {
      name: "checkout",
      parentPath: "/repo-worktrees/parent",
      childPath: "/repo-worktrees/parent",
      branch: "feature",
    },
  ])("create_threads uses the correct folder for a $name parent", (test) =>
    Effect.gen(function* () {
      const parent = parentProjection([]);
      const parentWithWorkspace = {
        ...parent,
        thread: { ...parent.thread, worktreePath: test.parentPath, branch: test.branch },
      };
      type CreateCommand = Extract<OrchestrationV2ServerCommand, { type: "thread.create" }>;
      const created = new Map<CommandId, CreateCommand>();
      const folderClaims: ThreadId[] = [];
      const child = () => {
        const command = [...created.values()][0]!;
        return {
          ...childProjection,
          thread: { ...parent.thread, ...command, id: command.threadId },
        };
      };
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/unused",
          folderForThread: ({ threadId, text }) =>
            Effect.sync(() => {
              folderClaims.push(threadId);
              assert.equal(text, "New top-level chat");
              return test.name === "scratch" ? Option.some(test.childPath) : Option.none();
            }),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: (id) => Effect.sync(() => created.has(id)),
          assertProviderInstanceEnabled: () => Effect.void,
          getThreadEventSequence: () => Effect.succeed(0),
          waitForThreadStartup: () => Effect.succeed({ startup: "still starting" as const }),
          getThreadRecords: (id) =>
            Effect.sync(() => (id === parentThreadId ? parentWithWorkspace : child())),
          getProjectThreadRecords: () => Effect.sync(child),
          dispatch: (command) =>
            Effect.sync(() => {
              if (command.type === "thread.create" && !created.has(command.commandId))
                created.set(command.commandId, command);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const input = {
          clientRequestId: "create-workspace",
          threads: [{ title: "New top-level chat" }],
        };
        const first = yield* service.createThreads(scope, input);
        const second = yield* service.createThreads(scope, input);
        const threadId = first.threads[0]?.threadId;
        assert.equal(second.threads[0]?.threadId, threadId);
        assert.equal(created.size, 1);
        assert.equal(child().thread.worktreePath, test.childPath);
        assert.equal(child().thread.branch, test.branch);
        if (test.name === "scratch") assert.deepEqual(folderClaims, [threadId]);
      }).pipe(Effect.provide(layerWithProviderStubs.pipe(Layer.provide(dependencies))));
    }),
  );

  describe("roomier sibling accounts", () => {
    const model = "gpt-5.4";
    const peerId = ProviderInstanceId.make("codex_work");
    const driver = ProviderDriverKind.make("codex");
    const window = {
      id: "weekly_model",
      kind: "weekly",
      label: "Weekly · GPT-5.4",
      usedPercent: 94,
    } as const;
    const usageFailure = {
      kind: "usage_limit",
      message: "Usage limit reached.",
      occurredAt: "2000-01-01T00:00:00.000Z",
      resetAt: "2999-01-01T00:00:00.000Z",
    } as const;
    const account = (instanceId: ProviderInstanceId, usedPercent: number): ServerProvider => ({
      ...providerSnapshot({ instanceId, driver, model }),
      displayName: instanceId === codexInstanceId ? "Codex" : "Plus-2",
      continuation: { groupKey: "codex:shared-home" },
      usageLimits: { checkedAt: "2026-11-16T12:00:00.000Z", windows: [{ ...window, usedPercent }] },
    });

    const harness = (
      input: {
        from?: Partial<ServerProvider>;
        sibling?: Partial<ServerProvider>;
        siblingAdapter?: boolean;
        siblingEnabledForProject?: boolean;
        replay?: boolean;
        extraSibling?: boolean;
        balanceAccounts?: boolean;
        parentSelection?: ModelSelection;
        settings?: Parameters<typeof ServerSettings.layerTest>[0];
        settingsLayer?: Layer.Layer<ServerSettings.ServerSettingsService>;
      } = {},
    ) => {
      const from = { ...account(codexInstanceId, 94), ...input.from };
      const sibling = { ...account(peerId, 4), ...input.sibling };
      const thirdId = ProviderInstanceId.make("codex_3");
      const providers = [from, sibling, ...(input.extraSibling ? [account(thirdId, 5)] : [])];
      const commands: OrchestrationV2ServerCommand[] = [];
      const selection = input.parentSelection ?? {
        instanceId: codexInstanceId,
        model,
        options: [{ id: "reasoning", value: "high" }],
      };
      let task: unknown;
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        providerRegistryLayer(providers),
        adapterRegistryLayer(
          providers
            .filter((p) => p.instanceId !== peerId || input.siblingAdapter !== false)
            .map((p) => p.instanceId),
        ),
        input.settingsLayer ??
          ServerSettings.layerTest({
            providerInstances: Object.fromEntries(
              providers.map((provider) => [
                provider.instanceId,
                { driver: provider.driver, enabled: true, config: {} },
              ]),
            ),
            balanceAccounts: input.balanceAccounts ?? true,
            ...input.settings,
          }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(input.replay ?? false),
          isProviderInstanceEnabledForProject: ({ instanceId }) =>
            Effect.succeed(instanceId !== peerId || input.siblingEnabledForProject !== false),
          assertProviderInstanceEnabled: () => Effect.void,
          getThreadEventSequence: () => Effect.succeed(0),
          waitForThreadStartup: () => Effect.succeed({ startup: "started" as const }),
          getThreadRecords: (id) =>
            Effect.succeed(
              id === parentThreadId
                ? parentProjection(task ? [task] : [], selection)
                : { ...childProjection, thread: { ...parentProjection([], selection).thread, id } },
            ),
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command);
              if (command.type !== "delegated_task.request")
                return { sequence: 1, storedEvents: [] } as never;
              task = {
                id: taskId,
                threadId: parentThreadId,
                runId: parentRunId,
                parentNodeId,
                origin: "app_owned",
                createdBy: "agent",
                driver,
                childThreadId,
                providerInstanceId: command.modelSelection.instanceId,
                model: command.modelSelection.model,
                modelSelection: command.modelSelection,
                status: "running",
              };
              return {
                sequence: 1,
                storedEvents: [
                  {
                    sequence: 1,
                    commandId: null,
                    event: { type: "subagent.updated", payload: task },
                  },
                ],
              } as never;
            }),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      return {
        commands,
        selection,
        layer: layerOrchestratorService.pipe(Layer.provide(dependencies)),
      };
    };

    it.effect("preserves and resolves retry keys containing an unpaired surrogate", () =>
      Effect.gen(function* () {
        const { layer, commands } = harness();
        const service = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(layer),
        );
        const keys = ["review-\ud83d", "review-\ufffd", "review-\\ud83d"];
        for (const clientRequestId of [...keys, keys[0]!]) {
          yield* service.delegateTask(scope, { task: "Review", mode: "async", clientRequestId });
        }
        const ids = commands
          .filter((command) => command.type === "delegated_task.request")
          .map((command) => ({
            id: `node:delegated-task:${encodeURIComponent(command.commandId)}`,
          }));
        assert.equal(ids[0]?.id, ids[3]?.id);
        const tasks = ids.slice(0, 3);
        assert.equal(new Set(tasks.map(({ id }) => id)).size, 3);
        keys.forEach((key, i) => assert.equal(resolveTaskReference(tasks, key), tasks[i]));
      }),
    );

    it.effect("returns a typed failure when target resolution cannot read settings", () =>
      Effect.gen(function* () {
        const { layer, commands } = harness({
          settingsLayer: Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.fail(
              new ServerSettingsError({ settingsPath: "<test>", operation: "read-file" }),
            ),
          }),
        });
        const error = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) =>
            mcp.delegateTask(scope, { task: "Review", mode: "async", clientRequestId: "settings" }),
          ),
          Effect.flip,
          Effect.provide(layer),
        );
        assert.equal(error.code, "orchestration_error");
        assert.isEmpty(commands);
      }),
    );

    it.effect.each(["omitted", "default"] as const)(
      "checks the resolved model when a driver-only %s target starts from a hidden model",
      (kind) => {
        const { layer } = harness({
          from: { usageLimits: account(codexInstanceId, 4).usageLimits },
          sibling: { usageLimits: account(peerId, 40).usageLimits },
          settings: {
            providerModelPreferences: {
              [codexInstanceId]: { hiddenModels: [model], modelOrder: [] },
            },
          },
        });
        return Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const result = yield* service.delegateTask(scope, {
            task: "Review this diff.",
            mode: "async",
            clientRequestId: `hidden-resolved-${kind}`,
            target: { driverKind: driver, ...(kind === "default" ? { model: "default" } : {}) },
          });
          assert.equal(result.providerInstanceId, peerId);
          assert.equal(result.model, model);
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect.each(["explicit", "driver-only", "limited", "limited-driver"] as const)(
      "excludes a hidden sibling model for %s delegation",
      (kind) => {
        const { layer, commands } = harness({
          settings: {
            providerModelPreferences: { [peerId]: { hiddenModels: [model], modelOrder: [] } },
          },
          ...(kind.startsWith("limited") ? { from: { recentFailure: usageFailure } } : {}),
        });
        return Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const listed = yield* service.capabilities(scope);
          assert.equal(
            listed.providers.find((provider) => provider.providerInstanceId === peerId)?.models
              .length,
            0,
          );
          const result = yield* Effect.result(
            service.delegateTask(scope, {
              task: "Review this diff.",
              mode: "async",
              clientRequestId: `hidden-${kind}`,
              target:
                kind === "driver-only" || kind === "limited-driver"
                  ? { driverKind: driver }
                  : { providerInstanceId: codexInstanceId, model },
            }),
          );
          if (kind.startsWith("limited")) {
            assert.equal(result._tag, "Failure");
            assert.equal(commands.length, 0);
          } else {
            assert.equal(result._tag, "Success");
            if (result._tag === "Success")
              assert.equal(result.success.providerInstanceId, codexInstanceId);
          }
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect.each([
      "supported",
      "missing",
      "wrong-group",
      "invalid-options",
      "other-model-limited",
      "inherited-model-limited",
      "default-wrong-group",
    ] as const)("preserves driver-only inherited model/options when fallback is %s", (scenario) => {
      const inherited = {
        instanceId: peerId,
        model: "gpt-6.1-terra",
        options: [{ id: "reasoning", value: "high" }],
      };
      const row = { ...account(peerId, 4).models[0]!, slug: inherited.model };
      const { layer, commands } = harness({
        parentSelection: inherited,
        from: {
          models: [
            { ...account(codexInstanceId, 94).models[0]!, slug: "gpt-6.1-sol" },
            ...(scenario === "missing"
              ? []
              : [
                  {
                    ...row,
                    ...(scenario === "invalid-options"
                      ? { capabilities: { optionDescriptors: [] } }
                      : {}),
                  },
                ]),
          ],
          ...(scenario === "wrong-group" || scenario === "default-wrong-group"
            ? { continuation: { groupKey: "codex:other" } }
            : {}),
          ...(scenario.endsWith("-limited")
            ? {
                recentFailure: {
                  ...usageFailure,
                  modelIds: [scenario === "other-model-limited" ? "gpt-6.1-sol" : inherited.model],
                },
              }
            : {}),
        },
        sibling: { models: [row], recentFailure: usageFailure },
      });
      return Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* Effect.result(
          service.delegateTask(
            { ...scope, thread: { ...scope.thread!, providerInstanceId: peerId } },
            {
              task: "Review this diff.",
              mode: "async",
              clientRequestId: `inherit-${scenario}`,
              target: {
                driverKind: driver,
                ...(scenario === "default-wrong-group" ? { model: "default" } : {}),
              },
            },
          ),
        );
        if (scenario === "supported" || scenario === "other-model-limited") {
          assert.equal(
            result._tag,
            "Success",
            result._tag === "Failure" ? JSON.stringify(result.failure) : undefined,
          );
          if (result._tag === "Success") assert.equal(result.success.model, inherited.model);
          const command = commands[0]!;
          if (command.type === "delegated_task.request")
            assert.deepEqual(command.modelSelection, {
              ...inherited,
              instanceId: codexInstanceId,
            });
        } else {
          assert.equal(result._tag, "Failure");
          assert.equal(commands.length, 0);
        }
      }).pipe(Effect.provide(layer));
    });

    it.effect.each([false, true])(
      "keeps the user's named account or returns its refusal (limited: %s)",
      (limited) => {
        const { commands, layer } = harness(
          limited ? { from: { recentFailure: usageFailure } } : {},
        );
        return Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const launch = service.delegateTask(scope, {
            task: "Review this diff.",
            mode: "async",
            target: { providerInstanceId: codexInstanceId, model, userNamedAccount: true },
          });
          if (limited) {
            const refusal = yield* launch.pipe(Effect.flip);
            assert.equal(refusal.code, "account_unavailable");
            assert.include(refusal.message, usageFailure.message);
            assert.lengthOf(commands, 0);
          } else {
            assert.equal((yield* launch).providerInstanceId, codexInstanceId);
            assert.lengthOf(commands, 1);
          }
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect("keeps the account the agent named while it can take the work", () =>
      Effect.gen(function* () {
        // The sibling has far more room; the agent still asked for this one.
        const { commands, selection, layer } = harness();
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const result = yield* service.delegateTask(scope, {
            task: "Review this diff.",
            mode: "async",
            clientRequestId: "named-account",
            target: { providerInstanceId: codexInstanceId, model, options: selection.options },
          });
          assert.equal(result.providerInstanceId, codexInstanceId);
          assert.isUndefined(result.notice);
          const command = commands[0]!;
          assert.equal(command.type, "delegated_task.request");
          if (command.type === "delegated_task.request")
            assert.deepEqual(command.modelSelection, selection);
        }).pipe(Effect.provide(layer));
      }),
    );

    it.effect.each(["inherited", "driver-only"] as const)(
      "starts a child on a roomier sibling for an %s target and preserves its selection",
      (kind) =>
        Effect.gen(function* () {
          const { commands, selection, layer } = harness();
          yield* Effect.gen(function* () {
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const result = yield* service.delegateTask(scope, {
              task: "Review this diff.",
              mode: "async",
              clientRequestId: `roomier-${kind}`,
              ...(kind === "inherited" ? {} : { target: { driverKind: driver } }),
            });
            assert.equal(result.providerInstanceId, peerId);
            assert.equal(
              result.notice,
              "Started on Plus-2: it has the most left to use before its reset.",
            );
            const command = commands[0]!;
            assert.equal(command.type, "delegated_task.request");
            if (command.type === "delegated_task.request")
              assert.deepEqual(command.modelSelection, { ...selection, instanceId: peerId });
          }).pipe(Effect.provide(layer));
        }),
    );

    it.effect.each([
      {
        name: "selected account has about as much room",
        from: { usageLimits: account(codexInstanceId, 2).usageLimits },
      },
      {
        name: "selected account has the most room",
        from: { usageLimits: account(codexInstanceId, 4).usageLimits },
        sibling: { usageLimits: account(peerId, 40).usageLimits },
      },
      {
        name: "another continuation group",
        sibling: { continuation: { groupKey: "codex:other-home" } },
      },
      { name: "signed out", sibling: { auth: { status: "unauthenticated" } } },
      { name: "model missing", sibling: { models: [] } },
      { name: "unavailable account", sibling: { recentFailure: usageFailure } },
      { name: "disabled", sibling: { enabled: false } },
      { name: "not installed", sibling: { installed: false } },
      { name: "provider error", sibling: { status: "error" } },
      {
        name: "legacy sibling model",
        sibling: { models: [{ ...account(peerId, 4).models[0]!, isLegacy: true }] },
      },
      {
        name: "gone sibling model",
        sibling: {
          models: [{ ...account(peerId, 4).models[0]!, unavailableReason: "Model removed." }],
        },
      },
      { name: "no adapter", siblingAdapter: false },
      { name: "project disabled", siblingEnabledForProject: false },
      { name: "recorded replay", replay: true },
    ] satisfies ReadonlyArray<Parameters<typeof harness>[0] & { name: string }>)(
      "keeps the resolved account when %s",
      (testCase) =>
        Effect.gen(function* () {
          const { layer } = harness(testCase);
          yield* Effect.gen(function* () {
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const result = yield* service.delegateTask(scope, {
              task: "Review this diff.",
              mode: "async",
              clientRequestId: `unchanged-${testCase.name}`,
            });
            assert.equal(result.providerInstanceId, codexInstanceId);
            assert.isUndefined(result.notice);
          }).pipe(Effect.provide(layer));
        }),
    );

    it.effect.each([true, false])(
      "handles a usage-limited account with a qualifying sibling: %s",
      (available) =>
        Effect.gen(function* () {
          const { layer } = harness({
            from: { recentFailure: usageFailure },
            siblingEnabledForProject: available,
          });
          yield* Effect.gen(function* () {
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const result = service.delegateTask(scope, {
              task: "Review this diff.",
              mode: "async",
              clientRequestId: "limited-account",
              target: { providerInstanceId: codexInstanceId, model },
            });
            if (available) {
              const started = yield* result;
              assert.equal(started.providerInstanceId, peerId);
              assert.equal(started.notice, "Started on Plus-2: Codex reached its usage limit.");
            } else {
              const error = yield* result.pipe(Effect.flip);
              assert.equal(error.code, "account_unavailable");
              assert.equal(error.message, "Usage limit reached. Recheck 2999-01-01T00:00:00.000Z.");
            }
          }).pipe(Effect.provide(layer));
        }),
    );

    // Signed out, with a limits read that failed too: it stands until a sign-in works.
    const signedOutFailure = {
      kind: "authentication_error",
      message:
        "Signed out. Sign in again with `CLAUDE_CONFIG_DIR=/Users/me/.codex-1 claude auth login`.",
      occurredAt: "2000-01-01T00:00:00.000Z",
    } as const;

    it.effect.each([true, false])(
      "refuses a signed-out account the agent named, without starting a child (confirmed: %s)",
      (confirmed) =>
        Effect.gen(function* () {
          const recentFailure = confirmed
            ? signedOutFailure
            : { ...signedOutFailure, resetAt: "2999-01-01T00:00:00.000Z" };
          const { commands, layer } = harness({ from: { recentFailure } });
          yield* Effect.gen(function* () {
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const error = yield* service
              .delegateTask(scope, {
                task: "Review this diff.",
                mode: "async",
                clientRequestId: `named-signed-out-${confirmed}`,
                target: { providerInstanceId: codexInstanceId, model },
              })
              .pipe(Effect.flip);
            assert.equal(error.code, "account_unavailable");
            assert.equal(
              error.message,
              confirmed
                ? signedOutFailure.message
                : `${signedOutFailure.message} Recheck 2999-01-01T00:00:00.000Z.`,
            );
            assert.lengthOf(commands, 0);
          }).pipe(Effect.provide(layer));
        }),
    );

    it.effect.each([true, false])(
      "moves an inherited subagent off a signed-out account to a sibling: %s",
      (available) =>
        Effect.gen(function* () {
          const { commands, selection, layer } = harness({
            from: { recentFailure: signedOutFailure },
            siblingEnabledForProject: available,
          });
          yield* Effect.gen(function* () {
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const result = service.delegateTask(scope, {
              task: "Review this diff.",
              mode: "async",
              clientRequestId: `inherited-signed-out-${available}`,
            });
            if (available) {
              const started = yield* result;
              assert.equal(started.providerInstanceId, peerId);
              assert.equal(started.notice, "Started on Plus-2: Codex is signed out.");
              const command = commands[0]!;
              if (command.type === "delegated_task.request")
                assert.deepEqual(command.modelSelection, { ...selection, instanceId: peerId });
            } else {
              const error = yield* result.pipe(Effect.flip);
              assert.equal(error.code, "account_unavailable");
              assert.equal(error.message, signedOutFailure.message);
              assert.lengthOf(commands, 0);
            }
          }).pipe(Effect.provide(layer));
        }),
    );

    it.effect.each([
      { name: "probe-only sign-out with cleared models", withFailure: false, available: true },
      { name: "probe-only sign-out without sibling", withFailure: false, available: false },
      { name: "confirmed sign-out with unauthenticated probe", withFailure: true, available: true },
      { name: "confirmed sign-out without sibling", withFailure: true, available: false },
    ])(
      "moves an inherited subagent off an unauthenticated account to a sibling ($name)",
      ({ withFailure, available }) =>
        Effect.gen(function* () {
          const { commands, selection, layer } = harness({
            from: {
              auth: { status: "unauthenticated" },
              status: "error",
              message: "Not authenticated.",
              models: [],
              ...(withFailure ? { recentFailure: signedOutFailure } : {}),
            },
            siblingEnabledForProject: available,
          });
          yield* Effect.gen(function* () {
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const result = service.delegateTask(scope, {
              task: "Review this diff.",
              mode: "async",
              clientRequestId: `inherited-unauth-${withFailure}-${available}`,
            });
            if (available) {
              const started = yield* result;
              assert.equal(started.providerInstanceId, peerId);
              assert.equal(started.notice, "Started on Plus-2: Codex is signed out.");
              const command = commands[0]!;
              if (command.type === "delegated_task.request")
                assert.deepEqual(command.modelSelection, { ...selection, instanceId: peerId });
            } else {
              const error = yield* result.pipe(Effect.flip);
              assert.equal(
                error.code,
                withFailure ? "account_unavailable" : "provider_unavailable",
              );
              assert.lengthOf(commands, 0);
            }
          }).pipe(Effect.provide(layer));
        }),
    );

    it.effect.each(["explicit", "driver-only"] as const)(
      "does not refuse an unrelated model for a scoped limit (%s)",
      (kind) =>
        Effect.gen(function* () {
          const { layer } = harness({
            from: {
              recentFailure: { ...usageFailure, modelIds: ["another-model"] },
              usageLimits: account(codexInstanceId, 2).usageLimits,
            },
            sibling: { usageLimits: account(peerId, 40).usageLimits },
          });
          yield* Effect.gen(function* () {
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const started = yield* service.delegateTask(scope, {
              task: "Review this diff.",
              mode: "async",
              clientRequestId: `unrelated-limit-${kind}`,
              target:
                kind === "explicit"
                  ? { providerInstanceId: codexInstanceId, model }
                  : { driverKind: driver, model },
            });
            assert.equal(started.providerInstanceId, codexInstanceId);
            const listed = yield* service.capabilities(scope, {});
            assert.isUndefined(
              listed.providers.find((p) => p.providerInstanceId === codexInstanceId)
                ?.accountUnavailable,
            );
          }).pipe(Effect.provide(layer));
        }),
    );

    it.effect("moves off a usage-limited account that reports no limit figures", () =>
      Effect.gen(function* () {
        const { usageLimits: _fromLimits, ...from } = account(codexInstanceId, 94);
        const { layer } = harness({
          from: { ...from, recentFailure: usageFailure, usageLimits: undefined },
          sibling: { usageLimits: undefined },
        });
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const started = yield* service.delegateTask(scope, {
            task: "Review this diff.",
            mode: "async",
            clientRequestId: "limited-account-without-figures",
            target: { providerInstanceId: codexInstanceId, model },
          });
          assert.equal(started.providerInstanceId, peerId);
          assert.equal(started.notice, "Started on Plus-2: Codex reached its usage limit.");
        }).pipe(Effect.provide(layer));
      }),
    );

    it.effect("chooses a usable sibling even when an ineligible one has more room", () =>
      Effect.gen(function* () {
        const { layer } = harness({ siblingEnabledForProject: false, extraSibling: true });
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const result = yield* service.delegateTask(scope, {
            task: "Review this diff.",
            mode: "async",
            clientRequestId: "third-account",
          });
          assert.equal(result.providerInstanceId, "codex_3");
          assert.equal(
            result.notice,
            "Started on Plus-2: it has the most left to use before its reset.",
          );
        }).pipe(Effect.provide(layer));
      }),
    );

    it.effect.each([
      {
        name: "has more left",
        from: { usageLimits: account(codexInstanceId, 40).usageLimits },
        notice: "Started on Plus-2: it has the most left to use before its reset.",
      },
      {
        name: "is the one whose limits for this model are known",
        from: {
          usageLimits: {
            checkedAt: "2026-11-16T12:00:00.000Z",
            windows: [{ ...window, label: "Weekly · Fable" }],
          },
        },
        notice: "Started on Plus-2: it has room.",
      },
    ])("starts a child on the sibling that $name", (testCase) =>
      Effect.gen(function* () {
        const { layer } = harness({ from: testCase.from });
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const result = yield* service.delegateTask(scope, {
            task: "Review this diff.",
            mode: "async",
            clientRequestId: `balanced-${testCase.name}`,
          });
          assert.equal(result.providerInstanceId, peerId);
          assert.equal(result.notice, testCase.notice);
        }).pipe(Effect.provide(layer));
      }),
    );

    it.effect.each(["inherited", "driver", "instance"] as const)(
      "honors balancing off for a refused %s target before dispatch",
      (kind) => {
        const { layer, commands } = harness({
          balanceAccounts: false,
          from: { recentFailure: usageFailure },
        });
        return Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const result = yield* Effect.result(
            service.delegateTask(scope, {
              task: "Review this diff.",
              mode: "async",
              clientRequestId: `off-${kind}`,
              ...(kind === "driver"
                ? { target: { driverKind: driver } }
                : kind === "instance"
                  ? { target: { providerInstanceId: codexInstanceId, model } }
                  : {}),
            }),
          );
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") assert.equal(result.failure.code, "account_unavailable");
          assert.equal(commands.length, 0);
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect("keeps the account asked for when balancing is off and it can take the work", () =>
      Effect.gen(function* () {
        const { layer } = harness({ balanceAccounts: false });
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const result = yield* service.delegateTask(scope, {
            task: "Review this diff.",
            mode: "async",
            clientRequestId: "balancing-off",
            target: { providerInstanceId: codexInstanceId, model },
          });
          assert.equal(result.providerInstanceId, codexInstanceId);
          assert.isUndefined(result.notice);
        }).pipe(Effect.provide(layer));
      }),
    );

    it.effect("names an exhausted account and falls back to instance ids", () =>
      Effect.gen(function* () {
        const { layer } = harness({
          from: { displayName: undefined, usageLimits: account(codexInstanceId, 100).usageLimits },
          sibling: { displayName: undefined },
        });
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const result = yield* service.delegateTask(scope, {
            task: "Review this diff.",
            mode: "async",
            clientRequestId: "exhausted-account",
            target: { providerInstanceId: codexInstanceId, model },
          });
          assert.equal(result.providerInstanceId, peerId);
          assert.equal(
            result.notice,
            "Started on codex_work: codex reached its Weekly · GPT-5.4 limit.",
          );
        }).pipe(Effect.provide(layer));
      }),
    );

    it.effect("returns the sibling and its training notice from create_threads", () =>
      Effect.gen(function* () {
        const { layer } = harness({
          from: { recentFailure: usageFailure },
          sibling: { trainsOnContent: true },
        });
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const result = yield* service.createThreads(scope, {
            threads: [{ target: { providerInstanceId: codexInstanceId, model } }],
          });
          assert.equal(result.threads[0]?.providerInstanceId, peerId);
          assert.equal(
            result.threads[0]?.notice,
            "Started on Plus-2: Codex reached its usage limit. Plus-2 trains on what this subagent is sent.",
          );
        }).pipe(Effect.provide(layer));
      }),
    );
  });

  it.effect("shows current model streaks and starts the selected model with both notices", () =>
    Effect.gen(function* () {
      const model = "gpt-5.4";
      const failure = {
        count: 3,
        at: 0,
        message: "HTTP 429 Resource exhausted. Please try again later.",
      };
      const peer = ProviderInstanceId.make("peer");
      const providers = [
        {
          ...providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model,
          }),
          trainsOnContent: true,
        },
        providerSnapshot({ instanceId: peer, driver: ProviderDriverKind.make("codex"), model }),
      ];
      const commands: OrchestrationV2ServerCommand[] = [];
      const task = {
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        childThreadId,
        model,
        modelSelection: { instanceId: codexInstanceId, model },
        status: "running",
      };
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        mockProviderRegistry({
          getProviders: Effect.succeed(providers),
          getModelFailures: Effect.sync(
            () =>
              new Map([
                [modelRankingSelectionKey({ instanceId: codexInstanceId, model }), failure],
              ]),
          ),
        }),
        adapterRegistryLayer([codexInstanceId, peer]),
        ServerSettings.layerTest(),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          isProviderInstanceEnabledForProject: () => Effect.succeed(true),
          assertProviderInstanceEnabled: () => Effect.void,
          getThreadRecords: (id) =>
            Effect.succeed(
              id === parentThreadId
                ? parentProjection(commands.length ? [task] : [])
                : childProjection,
            ),
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command);
              return {
                sequence: 1,
                storedEvents: [
                  {
                    sequence: 1,
                    commandId: null,
                    event: { type: "subagent.updated", payload: task },
                  },
                ],
              } as never;
            }),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        yield* TestClock.adjust(Duration.minutes(12));
        const listed = yield* service.capabilities(scope);
        assert.equal(
          listed.providers[0]!.models[0]!.recentFailure,
          `3 failed in a row, last 12m ago: ${failure.message}`,
        );
        assert.isFalse("recentFailure" in listed.providers[1]!.models[0]!);
        yield* TestClock.adjust(Duration.minutes(1));
        assert.include(
          (yield* service.capabilities(scope)).providers[0]!.models[0]!.recentFailure!,
          "last 13m ago",
        );
        const result = yield* service.delegateTask(scope, {
          task: "Review the diff.",
          target: { providerInstanceId: codexInstanceId, model },
          mode: "async",
          clientRequestId: "model-failure-notice",
        });
        assert.equal(result.status, "running");
        assert.equal(
          result.notice,
          `${model} failed its last 3 runs: ${failure.message} codex trains on what this subagent is sent.`,
        );
        assert.equal(commands.length, 1);
        assert.equal(commands[0]!.type, "delegated_task.request");
        if (commands[0]!.type === "delegated_task.request")
          assert.deepEqual(commands[0]!.modelSelection, { instanceId: codexInstanceId, model });
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    }),
  );

  it.effect(
    "create_threads warns about credit exhaustion without refusing the chosen instance",
    () =>
      Effect.gen(function* () {
        const creditFailure = {
          kind: "billing_error",
          outOfCredit: true,
          occurredAt: "2026-11-03T00:00:00.000Z",
          message: "Budget exhausted.",
        } as const;
        const provider = {
          ...providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          recentFailure: creditFailure,
        };
        const parent = parentProjection([]);
        const dispatched: string[] = [];
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: () => Effect.succeed(false),
            assertProviderInstanceEnabled: () => Effect.void,
            getThreadEventSequence: () => Effect.succeed(0),
            waitForThreadStartup: () => Effect.succeed({ startup: "started" as const }),
            getThreadRecords: (id) =>
              Effect.succeed(
                id === parentThreadId
                  ? parent
                  : ({
                      ...childProjection,
                      thread: {
                        ...parent.thread,
                        id,
                        title: "Retry credit",
                        createdBy: "agent",
                        creationSource: "mcp",
                      },
                    } as OrchestrationV2ThreadProjection),
              ),
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command.type);
                return { sequence: 1, storedEvents: [] } as never;
              }),
          }),
          ServerSettings.layerTest(),
          providerRegistryLayer([provider]),
          adapterRegistryLayer([codexInstanceId]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const usage = yield* service.usageLimits(scope, { providerInstanceId: codexInstanceId });
          assert.equal(
            usage.providers[0]?.accountUnavailable?.reason,
            formatOutOfCredit(creditFailure),
          );
          const capabilities = yield* service.capabilities(scope, {
            providerInstanceId: codexInstanceId,
          });
          assert.deepEqual(capabilities.providers[0]?.accountUnavailable, {
            reason: formatOutOfCredit(creditFailure),
          });
          const result = yield* service.createThreads(scope, {
            threads: [
              {
                title: "Retry credit",
                target: {
                  providerInstanceId: codexInstanceId,
                  model: "gpt-5.4",
                  userNamedModel: true,
                },
              },
            ],
          });
          assert.equal(result.threads[0]?.providerInstanceId, codexInstanceId);
          assert.equal(result.threads[0]?.notice, formatOutOfCredit(creditFailure));
          assert.include(dispatched, "thread.create");
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
      }),
  );

  it.effect.each([
    "usage_limit",
    "billing_error",
    "subscription_error",
    "authentication_error",
    "permission_error",
  ] as const)(
    "exposes %s in capabilities and refuses an explicit choice without rerouting",
    (kind) =>
      Effect.gen(function* () {
        const account = {
          reason:
            kind === "usage_limit" ? "Usage limit reached." : "Account access needs attention.",
          recheckAt: "2999-01-01T00:00:00.000Z",
        };
        const provider = {
          ...providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          recentFailure: {
            kind,
            message: account.reason,
            occurredAt: "2000-01-01T00:00:00.000Z",
            resetAt: account.recheckAt,
          },
        };
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(parentProjection([])),
            hasReceipt: () => Effect.succeed(false),
            dispatch: () => Effect.die("Unavailable accounts must fail before dispatch"),
          }),
          ServerSettings.layerTest(),
          mockProviderRegistry({
            getProviders: Effect.succeed([provider]),
            refreshInstance: () => Effect.die("An account failure must fail fast without probing"),
          }),
          adapterRegistryLayer([codexInstanceId]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const result = yield* service.capabilities(scope);
          assert.deepEqual(result.providers[0]?.accountUnavailable, account);
          assert.isFalse(result.providers[0]?.canRunChildTask);
          assert.deepEqual(result.providers[0]?.models, []);
          const detail = yield* service.capabilities(scope, {
            providerInstanceId: codexInstanceId,
          });
          assert.deepEqual(
            detail.providers[0]?.models.map((model) => model.id),
            ["gpt-5.4"],
          );
          const error = yield* service
            .delegateTask(scope, {
              task: "Check this diff",
              clientRequestId: `account-${kind}`,
              mode: "async",
              target: {
                providerInstanceId: codexInstanceId,
                model: "gpt-5.4",
                userNamedModel: true,
              },
            })
            .pipe(Effect.flip);
          assert.equal(error.code, "account_unavailable");
          assert.equal(error.message, `${account.reason} Recheck ${account.recheckAt}.`);
          // Expiry permits a new pick even when no foreground probe has run.
          yield* TestClock.setTime(Date.parse(account.recheckAt));
          const recovered = yield* service.capabilities(scope);
          assert.isUndefined(recovered.providers[0]?.accountUnavailable);
          // Able to run again: the default is left out.
          assert.isUndefined(recovered.providers[0]?.canRunChildTask);
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
      }),
  );

  it.effect(
    "gradeTasks saves grades only for finished tasks owned by the caller and never fails",
    () =>
      Effect.gen(function* () {
        const taskId = NodeId.make(
          `node:delegated-task:${encodeURIComponent("command:mcp:session:delegate-task:grade")}`,
        );
        const grades: Array<readonly [NodeId, RecordedGrade & { runTaskId?: NodeId }]> = [];
        let done = false;
        let failed = false;
        let output: "none" | "message" | "item" | "unrelated" = "none";
        let childThread: Partial<OrchestrationV2ThreadProjection["thread"]> = {
          title: "graded child",
        };
        const resultRunId = RunId.make("graded-child-run");
        const grader = { instanceId: codexInstanceId, family: "codex" };
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(SubagentRankings)({
            gradeMany: (entries) =>
              entries.some((grade) => grade.score === 1)
                ? Effect.fail(new SubagentRankingsError({ operation: "grade", message: "no run" }))
                : Effect.sync(() => {
                    for (const { taskId, ...grade } of entries) grades.push([taskId, grade]);
                    return {
                      unmatched: entries.flatMap((grade) =>
                        grade.runTaskId === "unranked-original" ? [grade.taskId] : [],
                      ),
                    };
                  }),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (threadId) =>
              Effect.sync(() =>
                threadId === parentThreadId
                  ? parentProjection([
                      {
                        id: taskId,
                        threadId: parentThreadId,
                        childThreadId,
                        origin: "app_owned",
                        status: failed ? "failed" : done ? "completed" : "running",
                        result: failed
                          ? "Claude gave up after repeated API errors."
                          : done
                            ? "done"
                            : null,
                        providerInstanceId: codexInstanceId,
                        model: "gpt-5.4",
                        completionDelivery: { state: "acknowledged" },
                      },
                    ])
                  : ({
                      ...childProjection,
                      thread: { ...childProjection.thread, ...childThread },
                      messages:
                        output === "message" || output === "unrelated"
                          ? [
                              {
                                id: MessageId.make("grade-output"),
                                runId:
                                  output === "unrelated"
                                    ? RunId.make("unrelated-graded-run")
                                    : resultRunId,
                                role: "assistant",
                                text: "Work completed before the outage",
                                updatedAt: DateTime.makeUnsafe("2026-11-06T00:00:00Z"),
                              },
                            ]
                          : [],
                      turnItems:
                        output === "item"
                          ? [
                              {
                                runId: resultRunId,
                                type: "assistant_message",
                                text: "Work completed",
                                ordinal: 1,
                              },
                            ]
                          : [],
                      runs: [
                        {
                          id: resultRunId,
                          ordinal: 1,
                          delegatedTaskId: taskId,
                          status: failed ? "failed" : "completed",
                        },
                        {
                          id: RunId.make("unrelated-graded-run"),
                          ordinal: 2,
                          delegatedTaskId: NodeId.make("unrelated-task"),
                          status: "completed",
                          startedAt: DateTime.makeUnsafe("2026-11-06T00:00:00Z"),
                        },
                      ],
                    } as unknown as OrchestrationV2ThreadProjection),
              ),
          }),
          ServerSettings.layerTest(),
          providerRegistryLayer([]),
          adapterRegistryLayer([]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const grade = { score: 4, note: "Good fix" };
          // Early, unknown or unsaveable grades are skipped without an error.
          yield* service.gradeTasks(scope, [{ taskId, ...grade }]);
          done = true;
          yield* service.gradeTasks(scope, [
            { taskId: NodeId.make("another-task"), ...grade },
            { taskId, score: 1 },
          ]);
          assert.deepEqual(grades, []);
          const feedback = yield* service.gradeTasks(scope, [
            { taskId, ...grade, note: "x".repeat(81) },
            { taskId: "bad", score: 0 },
            null,
          ]);
          assert.deepEqual(feedback, {
            saved: 1,
            skipped: [{ taskId: "bad", reason: "invalid grade" }, { reason: "invalid grade" }],
          });
          assert.deepEqual(grades, [[taskId, { ...grade, note: "x".repeat(80), grader }]]);
          yield* service.gradeTasks(scope, undefined);
          assert.equal(grades.length, 1);
          const gradedByHandle = yield* service.gradeTasks(scope, [
            { taskId: taskReference(taskId), score: 10 },
          ]);
          assert.equal(gradedByHandle.saved, 1);
          assert.deepEqual(grades[1], [taskId, { score: 10, grader }]);
          assert.equal(
            (yield* service.gradeTasks(scope, [{ taskId: "grade", score: 9 }])).saved,
            1,
          );
          assert.deepEqual(grades[2], [taskId, { score: 9, grader }]);
          // A run the provider cut short is not rated, whatever it wrote before it ended.
          failed = true;
          for (const written of ["none", "unrelated", "message", "item"] as const) {
            output = written;
            assert.deepEqual(yield* service.gradeTasks(scope, [{ taskId, score: 2 }]), {
              saved: 0,
              skipped: [{ taskId, reason: "ended on a provider failure" }],
            });
          }
          failed = false;
          assert.deepEqual(
            yield* service.gradeTasks(scope, [{ taskId: taskReference(taskId), score: 1 }]),
            {
              saved: 0,
              skipped: [{ taskId: taskReference(taskId), reason: "save failed" }],
            },
          );
          // A follow-up continues the child its original task forked, so its grade names that run.
          const original = NodeId.make("original-task");
          childThread = { title: "graded child", forkedFrom: { type: "node", nodeId: original } };
          assert.equal(
            (yield* service.gradeTasks(scope, [{ taskId: taskReference(taskId), score: 5 }])).saved,
            1,
          );
          assert.deepEqual(grades.at(-1), [taskId, { score: 5, runTaskId: original, grader }]);
          // One whose original run is not ranked is reported, not silently kept.
          childThread = {
            title: "graded child",
            forkedFrom: { type: "node", nodeId: NodeId.make("unranked-original") },
          };
          assert.deepEqual(yield* service.gradeTasks(scope, [{ taskId, score: 5 }]), {
            saved: 0,
            skipped: [{ taskId, reason: "not ranked" }],
          });
          childThread = { title: "Council: gpt-6.2-sol" };
          const before = grades.length;
          assert.deepEqual(yield* service.gradeTasks(scope, [{ taskId, score: 5 }]), {
            saved: 0,
            skipped: [{ taskId, reason: "not ranked" }],
          });
          assert.equal(grades.length, before);
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
      }),
  );

  it.effect("adds exact-model run evidence without filtering or reordering the catalog", () =>
    Effect.gen(function* () {
      const providers = [
        providerSnapshot({
          instanceId: codexInstanceId,
          driver: ProviderDriverKind.make("codex"),
          model: "gpt-5.4",
        }),
        providerSnapshot({
          instanceId: ProviderInstanceId.make("other"),
          driver: ProviderDriverKind.make("codex"),
          model: "gpt-5.4",
        }),
      ];
      const yourRuns = "4 runs · 0% done · 1.0/5 · 👍0 👎4 · 21m median";
      let hasData = false;
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(SubagentRankings)({
          getSnapshot: () =>
            Effect.sync(() => ({
              models: hasData
                ? [
                    {
                      instanceId: codexInstanceId,
                      model: "gpt-5.4",
                      family: "codex",
                      yourRuns,
                      byKind: [],
                    },
                  ]
                : [],
              thumbs: [],
            })),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(parentProjection([])),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer(providers),
        adapterRegistryLayer(providers.map((provider) => provider.instanceId)),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const empty = yield* service.capabilities(scope);
        assert.isFalse("yourRuns" in empty.providers[0]!.models[0]!);
        hasData = true;
        const result = yield* service.capabilities(scope);
        assert.deepEqual(
          result.providers.map((provider) => provider.models.map((model) => model.id)),
          [["gpt-5.4"], ["gpt-5.4"]],
        );
        assert.equal(result.providers[0]!.models[0]!.yourRuns, yourRuns);
        assert.deepEqual(result.providers[1]!.models, empty.providers[1]!.models);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    }),
  );

  it.effect.each(["steer", "promoted_queued_to_steer"])(
    "council returns ready answers and upgrades unfinished members on %s during setup",
    (intent) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<OrchestrationV2StoredEvent>({ replay: 16 });
        const prefix = "c".repeat(240);
        const started = yield* Deferred.make<void>();
        const tasks: OrchestrationV2ThreadProjection["subagents"][number][] = [];
        const commands: OrchestrationV2ServerCommand[] = [];
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: (id) =>
              Effect.succeed(
                intent === "promoted_queued_to_steer" && id.includes(`${prefix}%3Acouncil-`),
              ),
            getThreadEventSequence: () => Effect.succeed(0),
            getThreadShell: () =>
              Effect.succeed(liveThreadShell(parentThreadId, { activeRunId: parentRunId })),
            getThreadRecords: (id) =>
              Effect.sync(() => {
                if (id === parentThreadId) return parentProjection(tasks);
                const task = tasks.find((task) => task.childThreadId === id)!;
                return {
                  ...childProjection,
                  thread: { id },
                  runs: [
                    {
                      id: RunId.make(`run:${id}`),
                      ordinal: 1,
                      status: task.status,
                      startedAt: DateTime.makeUnsafe(0),
                      completedAt: task.status === "completed" ? DateTime.makeUnsafe(1) : null,
                    },
                  ],
                } as unknown as OrchestrationV2ThreadProjection;
              }),
            recoverDelegatedTask: () => Effect.void,
            delegatedTaskResultPending: () => Effect.succeed(false),
            streamStoredEventsFrom: (input) =>
              Stream.fromPubSub(events).pipe(
                Stream.filter(
                  (stored) =>
                    stored.sequence > (input?.afterSequence ?? 0) &&
                    stored.event.threadId === input!.threadId &&
                    stored.event.type === input!.eventType,
                ),
              ),
            dispatch: (command) =>
              Effect.gen(function* () {
                commands.push(command);
                if (command.type !== "delegated_task.request")
                  return { sequence: 1, storedEvents: [] } as never;
                const index = tasks.length;
                const task = {
                  id: NodeId.make(`node:council-${index}`),
                  threadId: parentThreadId,
                  runId: parentRunId,
                  parentNodeId,
                  origin: "app_owned",
                  driver: "codex",
                  childThreadId: ThreadId.make(`thread:council-${index}`),
                  providerInstanceId: codexInstanceId,
                  model: command.modelSelection.model,
                  status: index === 0 ? "completed" : "running",
                  result: index === 0 ? "Use a queue." : null,
                } as unknown as OrchestrationV2ThreadProjection["subagents"][number];
                tasks.push(task);
                if (tasks.length === 2) yield* Deferred.succeed(started, undefined);
                return {
                  sequence: 1,
                  storedEvents: [{ event: { type: "subagent.updated", payload: task } }],
                } as never;
              }),
          }),
          ServerSettings.layerTest(),
          providerRegistryLayer([
            providerSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
            }),
          ]),
          adapterRegistryLayer([codexInstanceId]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const question = {
            question: "Queue or direct calls?",
            members: [
              { providerInstanceId: codexInstanceId, model: "gpt-5.4" },
              { providerInstanceId: codexInstanceId, model: "gpt-5.4" },
            ],
            clientRequestId: `${prefix}a`,
          };
          const waiting = yield* service.council(scope, question).pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* PubSub.publish(events, {
            sequence: 2,
            event: {
              type: "turn-item.updated",
              threadId: parentThreadId,
              payload: { type: "user_message", runId: parentRunId, inputIntent: intent },
            },
          } as OrchestrationV2StoredEvent);
          const result = yield* Fiber.join(waiting);
          assert.deepEqual(
            result.answers.map((answer) => [answer.status, answer.answer, answer.waitTimedOut]),
            [
              ["completed", "Use a queue.", false],
              ["running", null, false],
            ],
          );
          assert.include(result.note, "Read the user's new message now.");
          assert.include(result.note, "1 member is still answering and will wake you when done.");
          assert.isTrue(
            commands.some(
              (command) =>
                command.type === "delegated_task.wake-policy" &&
                command.taskId === tasks[1]!.id &&
                command.completionWake === "always",
            ),
          );
          if (intent === "promoted_queued_to_steer") {
            const starts = commands.filter((command) => command.type === "delegated_task.request");
            assert.equal(starts.length, 2);
            assert.isTrue(
              starts.every((command) => command.commandId.includes(`${prefix}%3Acouncil-`)),
            );
          } else {
            const starts = () =>
              commands
                .filter((command) => command.type === "delegated_task.request")
                .map((command) => command.commandId);
            const original = starts();
            yield* service.council(scope, { ...question, clientRequestId: `${prefix}b` });
            yield* service.council(scope, question);
            const ids = starts();
            assert.equal(original.length, 2);
            assert.equal(new Set(ids.slice(0, 4)).size, 4);
            assert.deepEqual(ids.slice(4), original);
          }
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
      }),
  );

  it.effect.each(["steer", "promoted_queued_to_steer", "unrelated thread"])(
    "thread waits return current state on a caller %s",
    (intent) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
        const started = yield* Deferred.make<void>();
        const completed = yield* Deferred.make<void>();
        const notified = yield* Deferred.make<ThreadManagementService.ThreadManagementSendInput>();
        const unrelated = intent === "unrelated thread";
        let waits = 0;
        const commands: OrchestrationV2ServerCommand[] = [];
        const task = {
          id: taskId,
          childThreadId,
          threadId: parentThreadId,
          runId: parentRunId,
          status: "running",
          origin: "app_owned",
        };
        const childRun = {
          id: RunId.make("run:thread-wait-child"),
          ordinal: 1,
          status: "running",
          ...(unrelated ? {} : { delegatedTaskId: taskId }),
        };
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadEventSequence: () => Effect.succeed(0),
            getThreadShell: (id) =>
              Effect.succeed(liveThreadShell(id, { activeRunId: parentRunId })),
            getThreadRecords: () => Effect.succeed(parentProjection(unrelated ? [] : [task])),
            getProjectThreadRecords: () =>
              Effect.succeed({
                ...childProjection,
                thread: { ...parentProjection([]).thread, id: childThreadId },
                runs: [childRun],
              } as unknown as OrchestrationV2ThreadProjection),
            streamStoredEventsFrom: () => Stream.fromQueue(events),
            waitForThread: () =>
              Effect.suspend(() => {
                if (++waits === 1)
                  return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
                return Deferred.await(completed).pipe(
                  Effect.as({
                    threadId: childThreadId,
                    run: { ...childRun, status: "completed" },
                    timedOut: false,
                  } as unknown as ThreadManagementService.ThreadManagementWaitResult),
                );
              }),
            sendToThread: (input) => Deferred.succeed(notified, input).pipe(Effect.as({} as never)),
            dispatch: (command) =>
              Effect.sync(() => {
                commands.push(command);
                return {} as never;
              }),
          }),
          ServerSettings.layerTest(),
          providerRegistryLayer([]),
          adapterRegistryLayer([]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const waiting = yield* service
            .waitForThread(scope, { threadId: childThreadId })
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* Queue.offer(events, {
            sequence: 1,
            event: {
              type: "turn-item.updated",
              threadId: parentThreadId,
              payload: {
                type: "user_message",
                runId: parentRunId,
                inputIntent: unrelated ? "steer" : intent,
              },
            },
          } as OrchestrationV2StoredEvent);
          const result = yield* Fiber.join(waiting);
          assert.equal(result.runId, childRun.id);
          assert.equal(result.status, "running");
          assert.isFalse(result.timedOut);
          assert.include(result.notice ?? "", "Read the user's new message now.");
          if (unrelated) {
            yield* Deferred.succeed(completed, undefined);
            const notification = yield* Deferred.await(notified);
            assert.equal(notification.threadId, parentThreadId);
            assert.equal(notification.mode, "steer");
            assert.include(notification.text, "completed");
            assert.equal(commands.length, 0);
            return;
          }
          assert.isTrue(
            commands.some(
              (command) =>
                command.type === "delegated_task.wake-policy" &&
                command.taskId === taskId &&
                command.completionWake === "always",
            ),
          );
        }).pipe(
          Effect.provide(
            layerOrchestratorService.pipe(
              Layer.updateService(Crypto.Crypto, (crypto) =>
                unrelated
                  ? {
                      ...crypto,
                      randomUUIDv4: () =>
                        Effect.fail(
                          PlatformError.systemError({
                            _tag: "Unknown",
                            module: "Crypto",
                            method: "randomUUIDv4",
                          }),
                        ),
                    }
                  : crypto,
              ),
              Layer.provide(dependencies),
            ),
          ),
        );
      }),
  );

  it.effect.each([
    "parent completion",
    "nested child completion",
    "child run completion",
    "child question",
    "Node fetch's 300 s idle timeout",
    "a cancelled tools/call",
    "a steer",
    "a promoted queued steer",
  ] as const)("a task wait still returns on %s", (wake) =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
      const steers = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
      const dispatched: Array<string> = [];
      const subscribed = yield* Deferred.make<void>();
      const nestedId = NodeId.make("node:mcp-wait-nested");
      const childRunId = RunId.make("run:mcp-wait-child");
      const childRootId = NodeId.make("node:mcp-wait-child-root");
      const eventThreadId = wake === "parent completion" ? parentThreadId : childThreadId;
      const eventType =
        wake === "child run completion"
          ? "run.updated"
          : wake === "child question"
            ? "runtime-request.updated"
            : "subagent.updated";
      const terminal = wake.endsWith("completion");
      let ready = false;
      const task = () => ({
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        providerInstanceId: codexInstanceId,
        driver: "codex",
        childThreadId,
        model: "gpt-5.4",
        status: ready && terminal ? "completed" : "running",
        result: ready && wake === "parent completion" ? "done" : null,
      });
      const child = () =>
        ({
          ...childProjection,
          runs: [
            {
              id: childRunId,
              ordinal: 1,
              status:
                wake === "nested child completion" || (ready && terminal) ? "completed" : "running",
              startedAt: DateTime.makeUnsafe(0),
              completedAt: ready && terminal ? DateTime.makeUnsafe(1) : null,
            },
          ],
          subagents:
            wake === "nested child completion"
              ? [{ id: nestedId, status: ready ? "completed" : "running" }]
              : [],
          nodes: [{ id: childRootId, runId: childRunId }],
          turnItems:
            ready && !terminal
              ? [
                  {
                    type: "user_input_request",
                    requestId: "request:mcp-wait-answer",
                    questions: [{ header: "Choose target" }],
                  },
                ]
              : [],
          runtimeRequests:
            ready && !terminal
              ? [
                  {
                    id: "request:mcp-wait-answer",
                    nodeId: childRootId,
                    kind: wake === "child question" ? "user_input" : "command",
                    status: "pending",
                    responseCapability: { type: "live" },
                    createdAt: DateTime.makeUnsafe(0),
                  },
                ]
              : [],
        }) as unknown as OrchestrationV2ThreadProjection;
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          assertProviderInstanceEnabled: () => Effect.void,
          isProviderInstanceEnabledForProject: () => Effect.succeed(true),
          getThreadRecords: (threadId, _fields, filter) =>
            Effect.sync(() => {
              if (threadId === parentThreadId) return parentProjection([task()]);
              const projection = child();
              return {
                ...projection,
                turnItems: projection.turnItems.filter(
                  (item) =>
                    filter?.turnItemTypes === undefined || filter.turnItemTypes.includes(item.type),
                ),
              };
            }),
          getThreadEventSequence: () => Effect.succeed(0),
          getThreadShell: () =>
            Effect.succeed(liveThreadShell(parentThreadId, { activeRunId: parentRunId })),
          recoverDelegatedTask: () => Effect.void,
          delegatedTaskResultPending: () => Effect.succeed(false),
          streamStoredEventsFrom: (input) =>
            input?.threadId === parentThreadId && input.eventType === "turn-item.updated"
              ? Stream.fromQueue(steers)
              : input?.threadId === eventThreadId && input.eventType === eventType
                ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                    Stream.drain,
                    Stream.concat(Stream.fromQueue(events)),
                  )
                : Stream.never,
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.type);
              return {
                sequence: 1,
                storedEvents: [{ event: { type: "subagent.updated", payload: task() } }],
              } as never;
            }),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const waiting = yield* service
          .delegateTask(scope, { task: "Review the change.", mode: "wait" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(subscribed);
        if (wake === "Node fetch's 300 s idle timeout") {
          // Nothing is written during the wait, so undici drops the call at 300 s, before any handle.
          const beforeClientTimeout = yield* Fiber.join(waiting).pipe(
            Effect.timeoutOption(Duration.seconds(299)),
            Effect.forkChild,
          );
          yield* TestClock.adjust(Duration.seconds(299));
          const result = yield* Fiber.join(beforeClientTimeout);
          assert.isTrue(
            Option.isSome(result),
            "a wait without timeoutMs was still silent at 299 s, so a Node MCP client loses the taskId",
          );
          if (Option.isSome(result)) assert.isTrue(result.value.waitTimedOut);
          return;
        }
        if (wake === "a cancelled tools/call") {
          // A steered Claude parent cancels the tools/call, which interrupts this fiber.
          yield* Fiber.interrupt(waiting);
          assert.include(
            dispatched,
            "delegated_task.wake-policy",
            "a cancelled blocking delegation left the task settled_only, so its result never reaches the still-live parent run",
          );
          return;
        }
        if (wake === "a steer" || wake === "a promoted queued steer") {
          yield* Queue.offer(steers, {
            sequence: 2,
            event: {
              type: "turn-item.updated",
              threadId: parentThreadId,
              payload: {
                type: "user_message",
                runId: parentRunId,
                inputIntent: wake === "a steer" ? "steer" : "promoted_queued_to_steer",
              },
            },
          } as OrchestrationV2StoredEvent);
          const result = yield* Fiber.join(waiting);
          assert.equal(result.status, "running");
          assert.isUndefined(result.waitTimedOut);
          assert.include(result.notice ?? "", "Read the user's new message now.");
          assert.include(dispatched, "delegated_task.wake-policy");
          return;
        }
        ready = true;
        if (wake === "parent completion") {
          yield* Queue.offer(events, {
            sequence: 2,
            event: {
              type: "subagent.updated",
              threadId: parentThreadId,
              payload: { ...task(), id: nestedId },
            },
          } as unknown as OrchestrationV2StoredEvent);
        }
        yield* Queue.offer(events, {
          sequence: 3,
          event: {
            type: eventType,
            threadId: eventThreadId,
            payload: { id: wake === "parent completion" ? taskId : nestedId },
          },
        } as unknown as OrchestrationV2StoredEvent);
        const result = yield* Fiber.join(waiting);
        assert.isUndefined(result.waitTimedOut);
        if (terminal) {
          assert.equal(result.status, "completed");
          if (wake === "parent completion") assert.equal(result.summary, "done");
        } else {
          assert.equal(result.status, "running");
          assert.isTrue(result.hasPendingQuestion);
          assert.deepEqual(result.pendingRequests, [
            {
              id: RuntimeRequestId.make("request:mcp-wait-answer"),
              kind: "user_input",
              label: "Choose target",
            },
          ]);
        }
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    }),
  );

  it.effect(
    "advertises orchestration capability from registered adapters rather than a driver allowlist",
    () =>
      Effect.gen(function* () {
        const disabledAntigravityInstanceId = ProviderInstanceId.make("antigravity-alt");
        const forkOnlyInstanceId = ProviderInstanceId.make("forkOnly");
        const forkShadow = yield* buildUnavailableProviderSnapshot({
          driverKind: "forkOnly",
          instanceId: forkOnlyInstanceId,
          reason: "Driver 'forkOnly' is not registered in this build.",
          checkedAt: "2026-09-13T00:00:00.000Z",
        });
        let providers: ReadonlyArray<ServerProvider> = [
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          providerSnapshot({
            instanceId: ProviderInstanceId.make("claudeAgent"),
            driver: ProviderDriverKind.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          }),
          providerSnapshot({
            instanceId: ProviderInstanceId.make("pi"),
            driver: ProviderDriverKind.make("pi"),
            model: "pi-model",
          }),
          providerSnapshot({
            instanceId: ProviderInstanceId.make("acpRegistry"),
            driver: ProviderDriverKind.make("acpRegistry"),
            model: "acp-model",
          }),
          // Antigravity has a live orchestration adapter through the provider
          // instance registry even though no adapter driver entry exists in
          // the static built-in list.
          providerSnapshot({
            instanceId: antigravityInstanceId,
            driver: ProviderDriverKind.make("antigravity"),
            model: "ant-model",
          }),
          // A second Antigravity instance whose adapter resolves but whose
          // provider state still blocks delegation.
          providerSnapshot({
            instanceId: disabledAntigravityInstanceId,
            driver: ProviderDriverKind.make("antigravity"),
            model: "ant-model",
            enabled: false,
          }),
          forkShadow,
        ];
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(parentProjection([])),
          }),
          ServerSettings.layerTest(),
          mockProviderRegistry({
            getProviders: Effect.sync(() => providers),
          }),
          adapterRegistryLayer([
            codexInstanceId,
            ProviderInstanceId.make("claudeAgent"),
            ProviderInstanceId.make("pi"),
            ProviderInstanceId.make("acpRegistry"),
            antigravityInstanceId,
            disabledAntigravityInstanceId,
          ]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const capabilities = yield* service.capabilities(scope);
          const byId = new Map(
            capabilities.providers.map((provider) => [provider.providerInstanceId, provider]),
          );
          for (const provider of providers) {
            assert.deepEqual(
              byId.get(provider.instanceId)?.models.map((model) => model.id),
              provider.enabled && provider.instanceId !== forkOnlyInstanceId
                ? provider.models.map((model) => model.slug)
                : [],
            );
          }

          providers = providers.map((provider) => ({
            ...provider,
            models: [
              ...provider.models,
              {
                slug: `${provider.driver}/custom-model-after-refresh`,
                name: "Custom model",
                isCustom: true,
                capabilities: null,
              },
            ],
          }));
          const refreshed = yield* service.capabilities(scope);
          for (const provider of providers) {
            assert.deepEqual(
              refreshed.providers
                .find((entry) => entry.providerInstanceId === provider.instanceId)
                ?.models.map((model) => model.id),
              provider.enabled && provider.instanceId !== forkOnlyInstanceId
                ? provider.models.map((model) => model.slug)
                : [],
            );
          }

          for (const instanceId of [
            codexInstanceId,
            ProviderInstanceId.make("claudeAgent"),
            ProviderInstanceId.make("pi"),
            ProviderInstanceId.make("acpRegistry"),
            antigravityInstanceId,
          ]) {
            const entry = byId.get(instanceId);
            assert.isDefined(entry);
            // Runnable providers leave out the defaults.
            assert.isUndefined(entry!.canRunChildTask, `expected ${instanceId} to run child tasks`);
            assert.isUndefined(entry!.constraints);
          }

          const disabled = byId.get(disabledAntigravityInstanceId);
          assert.isDefined(disabled);
          assert.isFalse(disabled!.canRunChildTask);
          assert.deepEqual(disabled!.constraints, ["Provider instance is disabled."]);

          const fork = byId.get(forkOnlyInstanceId);
          assert.isDefined(fork);
          assert.isFalse(fork!.canRunChildTask);
          assert.lengthOf(fork!.constraints ?? [], 1);
          const detailedFork = yield* service.capabilities(scope, {
            providerInstanceId: forkOnlyInstanceId,
          });
          const forkConstraints = detailedFork.providers[0]?.constraints ?? [];
          assert.isTrue(
            forkConstraints.includes("No V2 provider adapter is registered."),
            `expected missing-adapter constraint, got ${forkConstraints.join(" | ")}`,
          );
          assert.isTrue(
            forkConstraints.includes("Driver 'forkOnly' is not registered in this build."),
          );
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }),
  );

  describe("usage limits", () => {
    const now = "2026-10-16T12:00:00.000Z";
    const limits = {
      checkedAt: "2026-10-16T11:59:00.000Z",
      credentialFingerprint: "private-credential-identity",
      windows: [
        {
          id: "primary",
          kind: "session",
          label: "5-hour",
          usedPercent: 35,
          resetsAt: "2026-10-16T14:10:00.000Z",
          windowDurationMins: 300,
        },
        {
          id: "secondary",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 70,
          resetsAt: "2026-10-18T12:00:00.000Z",
        },
        { id: "other", kind: "other", label: "Extra usage", usedPercent: 5 },
      ],
      resetCredits: {
        availableCount: 2,
        nextExpiresAt: "2026-11-01T00:00:00.000Z",
        nextCreditId: "redemption-id",
      },
    } as const;
    const codex: ServerProvider = {
      ...providerSnapshot({
        instanceId: codexInstanceId,
        driver: ProviderDriverKind.make("codex"),
      }),
      displayName: "Personal Codex",
      usageLimits: limits,
    };
    const unavailable: ServerProvider = {
      ...providerSnapshot({
        instanceId: ProviderInstanceId.make("claude"),
        driver: ProviderDriverKind.make("claudeAgent"),
      }),
      usageLimits: {
        checkedAt: "2026-10-16T11:00:00.000Z",
        windows: [],
        unavailable: { reason: "probeFailed", message: "Cached probe failed." },
      },
    };
    const source: UsageLimitSourceSnapshot = {
      id: UsageLimitSourceId.make("hub"),
      kind: "cliproxy",
      label: "Quota hub",
      checkedAt: now,
      accounts: [
        { id: "pooled-codex", driver: ProviderDriverKind.make("codex"), usageLimits: limits },
      ],
    };
    const usageLayer = (
      providers: readonly ServerProvider[],
      sources: readonly UsageLimitSourceSnapshot[] = [],
    ) =>
      layerOrchestratorMcpWithoutScratch.pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
            Layer.mock(GitVcsDriver.GitVcsDriver)({}),
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadRecords: () => Effect.succeed(parentProjection([])),
            }),
            mockProviderRegistry({
              getProviders: Effect.succeed(providers),
              // The registry decides which stale readings to re-probe; the tool only asks it.
              getProvidersForUsageLimits: () => Effect.succeed(providers),
              refresh: () => Effect.die("usage_limits must not refresh providers itself"),
              refreshInstance: () => Effect.die("usage_limits must not refresh providers itself"),
            }),
            Layer.mock(UsageLimitSources.UsageLimitSources)({
              current: Effect.succeed(sources),
              refresh: Effect.die("usage_limits must not refresh sources"),
            }),
            Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
            ServerSettings.layerTest(),
          ),
        ),
      );

    it.effect("reads cached windows, reset times and credits without credential identities", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(now));
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.usageLimits(scope, {});
        assert.equal(result.createdAt, now);
        assert.lengthOf(result.providers, 1);
        const provider = result.providers[0]!;
        assert.equal(provider.providerInstanceId, codexInstanceId);
        assert.equal(provider.driver, "codex");
        assert.equal(provider.displayName, "Personal Codex");
        assert.equal(provider.checkedAt, limits.checkedAt);
        assert.isFalse(provider.stale);
        assert.isUndefined(provider.unavailable);
        assert.deepEqual(
          provider.windows.map((window) => [window.label, window.usedPercent, window.resetsAt]),
          [
            ["5-hour", 35, "2026-10-16T14:10:00.000Z"],
            ["Weekly", 70, "2026-10-18T12:00:00.000Z"],
            ["Extra usage", 5, undefined],
          ],
        );
        assert.deepEqual(provider.resetCredits, {
          availableCount: 2,
          nextExpiresAt: "2026-11-01T00:00:00.000Z",
        });
        assert.notInclude(JSON.stringify(result), "private-credential-identity");
        assert.notInclude(JSON.stringify(result), "redemption-id");
      }).pipe(Effect.provide(usageLayer([codex]))),
    );

    it.effect("keeps unavailable readings and excludes disabled or unreported instances", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(now));
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.usageLimits(scope, {});
        assert.lengthOf(result.providers, 1);
        assert.deepEqual(result.providers[0]?.unavailable, {
          reason: "probeFailed",
          message: "Cached probe failed.",
        });
        assert.equal(result.providers[0]?.checkedAt, "2026-10-16T11:00:00.000Z");
        assert.isTrue(result.providers[0]?.stale);
      }).pipe(
        Effect.provide(
          usageLayer([
            unavailable,
            { ...codex, enabled: false },
            providerSnapshot({
              instanceId: ProviderInstanceId.make("pi"),
              driver: ProviderDriverKind.make("pi"),
            }),
          ]),
        ),
      ),
    );

    it.effect(
      "filters by instance identity without including sibling instances or pooled accounts",
      () =>
        Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const result = yield* service.usageLimits(scope, { providerInstanceId: codexInstanceId });
          assert.deepEqual(
            result.providers.map((provider) => provider.providerInstanceId),
            [codexInstanceId],
          );
          assert.deepEqual(result.sources, []);
          const missing = yield* service.usageLimits(scope, {
            providerInstanceId: ProviderInstanceId.make("missing"),
          });
          assert.deepEqual(missing.providers, []);
          assert.deepEqual(missing.sources, []);
        }).pipe(
          Effect.provide(
            usageLayer(
              [codex, unavailable, { ...codex, instanceId: ProviderInstanceId.make("codex-work") }],
              [source],
            ),
          ),
        ),
    );

    it.effect(
      "includes cached CLIProxy accounts and source failures separately from runnable instances",
      () =>
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(now));
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const result = yield* service.usageLimits(scope, {});
          assert.lengthOf(result.sources, 2);
          assert.equal(result.sources[0]?.sourceId, "hub");
          assert.isFalse(result.sources[0]?.stale);
          assert.equal(result.sources[0]?.accounts[0]?.accountId, "pooled-codex");
          assert.equal(
            result.sources[0]?.accounts[0]?.windows[0]?.resetsAt,
            "2026-10-16T14:10:00.000Z",
          );
          assert.equal(result.sources[0]?.accounts[0]?.resetCredits?.availableCount, 2);
          assert.equal(result.sources[1]?.unavailable, "Hub unreachable.");
          assert.isTrue(result.sources[1]?.stale);
        }).pipe(
          Effect.provide(
            usageLayer(
              [codex],
              [
                source,
                {
                  ...source,
                  id: UsageLimitSourceId.make("offline-hub"),
                  accounts: [],
                  checkedAt: "2026-10-16T11:00:00.000Z",
                  error: "Hub unreachable.",
                },
              ],
            ),
          ),
        ),
    );

    it.effect("marks old readings and expired windows stale without projecting a reset", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(now));
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.usageLimits(scope, {});
        assert.isTrue(result.providers[0]?.stale);
        assert.equal(result.providers[0]?.windows[0]?.usedPercent, 35);
        assert.equal(result.providers[0]?.windows[0]?.resetsAt, "2026-10-16T11:59:00.000Z");
        assert.isTrue(result.providers[1]?.stale);
      }).pipe(
        Effect.provide(
          usageLayer([
            {
              ...codex,
              usageLimits: {
                ...limits,
                windows: [{ ...limits.windows[0], resetsAt: "2026-10-16T11:59:00.000Z" }],
              },
            },
            {
              ...codex,
              instanceId: ProviderInstanceId.make("old-codex"),
              usageLimits: { ...limits, checkedAt: "2026-10-16T11:00:00.000Z" },
            },
          ]),
        ),
      ),
    );

    it.effect("requires the same orchestration capability as the provider catalog", () =>
      Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .usageLimits({ ...scope, capabilities: new Set() }, {})
          .pipe(Effect.flip);
        assert.equal(error.code, "capability_denied");
      }).pipe(Effect.provide(usageLayer([codex]))),
    );
  });

  it.effect("leaves models the user hid out of the capability catalog", () =>
    Effect.gen(function* () {
      const codex = providerSnapshot({
        instanceId: codexInstanceId,
        driver: ProviderDriverKind.make("codex"),
        model: "gpt-5.4",
      });
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(parentProjection([])),
        }),
        ServerSettings.layerTest({
          providerModelPreferences: {
            [codexInstanceId]: { hiddenModels: ["gpt-5.4-mini", "my-model"], modelOrder: [] },
          },
        }),
        providerRegistryLayer([
          {
            ...codex,
            models: [
              ...codex.models,
              { slug: "gpt-5.4-mini", name: "Mini", isCustom: false, capabilities: null },
              // Custom models cannot be hidden, matching the client pickers.
              { slug: "my-model", name: "Mine", isCustom: true, capabilities: null },
            ],
          },
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const capabilities = yield* service.capabilities(scope);
        assert.deepEqual(
          capabilities.providers[0]?.models.map((model) => model.id),
          ["gpt-5.4", "my-model"],
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("marks only the models their provider says cannot read images", () =>
    Effect.gen(function* () {
      const model = (slug: string, imageInput?: boolean) => ({
        slug,
        name: slug,
        family: `fixture-${slug}`,
        isCustom: false,
        capabilities: imageInput === undefined ? null : { optionDescriptors: [], imageInput },
      });
      const provider = {
        ...providerSnapshot({
          instanceId: codexInstanceId,
          driver: ProviderDriverKind.make("codex"),
        }),
        models: [model("text-only", false), model("sees", true), model("unsaid")],
      };
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(parentProjection([])),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([provider]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const capabilities = yield* service.capabilities(scope);
        assert.deepEqual(
          capabilities.providers[0]?.models.map((entry) => [entry.id, entry.images]),
          [
            ["text-only", false],
            ["sees", undefined],
            ["unsaid", undefined],
          ],
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    }),
  );

  it("marks only Gemini on Antigravity as taking audio and video files", () => {
    const reads = OrchestratorMcpService.readsAudioVideoFiles;
    assert.isTrue(reads(ProviderDriverKind.make("antigravity"), "gemini:neon"));
    // Another maker's model on the same harness, and Gemini on a route nobody has checked.
    assert.isFalse(reads(ProviderDriverKind.make("antigravity"), "claude:opus"));
    assert.isFalse(reads(ProviderDriverKind.make("opencode"), "gemini:neon"));
  });

  it.effect("pages a large live model catalog and returns options only on request", () =>
    Effect.gen(function* () {
      // One family each, so none is an older version of another.
      const models = Array.from({ length: 125 }, (_, index) => ({
        slug: `model-${index}`,
        name: `Model ${index}`,
        family: `fixture-${index}`,
        isCustom: index === 124,
        capabilities: {
          optionDescriptors: [{ id: "effort", label: "Effort", type: "boolean" as const }],
        },
      }));
      const provider = {
        ...providerSnapshot({
          instanceId: codexInstanceId,
          driver: ProviderDriverKind.make("codex"),
        }),
        models,
      };
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(parentProjection([])),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([provider]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const first = yield* service.capabilities(scope);
        assert.lengthOf(first.providers[0]!.models, 6);
        assert.isUndefined(first.providers[0]!.models[0]!.options);
        assert.equal(first.providers[0]!.totalModels, 125);
        assert.isBelow(JSON.stringify(first).length, 10_000);
        const ids: string[] = [];
        let cursor: number | undefined = 0;
        while (cursor !== undefined) {
          const page: OrchestratorMcpCapabilitiesResult = yield* service.capabilities(scope, {
            providerInstanceId: codexInstanceId,
            cursor,
            limit: 50,
          });
          ids.push(...page.providers[0]!.models.map((model) => model.id));
          cursor = page.providers[0]!.nextCursor;
        }
        assert.deepEqual(
          ids,
          models.map((model) => model.slug),
        );
        const search = yield* service.capabilities(scope, {
          providerInstanceId: codexInstanceId,
          modelSearch: "model-124",
          includeOptions: true,
        });
        assert.deepEqual(
          search.providers[0]!.models.map((model) => model.id),
          ["model-124"],
        );
        assert.isUndefined(search.providers[0]!.nextCursor);
        assert.deepEqual(
          search.providers[0]!.models[0]!.options,
          models[124]!.capabilities.optionDescriptors,
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    }),
  );

  it.effect("lists favorites first, then the picker's custom order", () =>
    Effect.gen(function* () {
      const models = Array.from({ length: 30 }, (_, index) => ({
        slug: `model-${index}`,
        name: `Model ${index}`,
        family: `fixture-${index}`,
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      }));
      const provider = {
        ...providerSnapshot({
          instanceId: codexInstanceId,
          driver: ProviderDriverKind.make("codex"),
        }),
        models,
      };
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(parentProjection([])),
        }),
        ServerSettings.layerTest({
          favorites: [
            { provider: codexInstanceId, model: "model-29" },
            { provider: ProviderInstanceId.make("other"), model: "model-1" },
            { provider: codexInstanceId, model: "model-25" },
          ],
          providerModelPreferences: {
            [codexInstanceId]: { hiddenModels: [], modelOrder: ["model-27", "model-25"] },
          },
        }),
        providerRegistryLayer([provider]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.capabilities(scope, { limit: 4 });
        assert.deepEqual(
          result.providers[0]!.models.map((model) => model.id),
          ["model-29", "model-25", "model-27", "model-0"],
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    }),
  );

  it.effect("marks a model the same provider offers a newer version of", () =>
    Effect.gen(function* () {
      const codex = providerSnapshot({
        instanceId: codexInstanceId,
        driver: ProviderDriverKind.make("codex"),
        model: "gpt-6.1-sol",
      });
      const catalog = (hiddenModels: ReadonlyArray<string>, modelSearch?: string) =>
        Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          return (yield* service.capabilities(
            scope,
            modelSearch === undefined ? {} : { modelSearch },
          )).providers[0]?.models.map((model) => [model.id, model.supersededBy ?? null]);
        }).pipe(
          Effect.provide(
            layerOrchestratorService.pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  Layer.mock(ThreadManagementService.ThreadManagementService)({
                    getThreadRecords: () => Effect.succeed(parentProjection([])),
                  }),
                  ServerSettings.layerTest({
                    providerModelPreferences: {
                      [codexInstanceId]: { hiddenModels: [...hiddenModels], modelOrder: [] },
                    },
                  }),
                  providerRegistryLayer([
                    {
                      ...codex,
                      models: [
                        ...codex.models,
                        {
                          slug: "gpt-6-astra",
                          name: "GPT-6-Astra",
                          isCustom: false,
                          capabilities: null,
                        },
                        {
                          slug: "gpt-6-sol",
                          name: "GPT-6-Sol",
                          isCustom: false,
                          capabilities: null,
                        },
                      ],
                    },
                  ]),
                  adapterRegistryLayer([codexInstanceId]),
                  Layer.mock(ProjectService.ProjectService)({}),
                  Layer.mock(SecretRequests.SecretRequests)({}),
                  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
                ),
              ),
            ),
          ),
        );
      // The default listing leaves the old version out; a search that names it finds it.
      assert.deepEqual(yield* catalog([]), [
        ["gpt-6.1-sol", null],
        ["gpt-6-astra", null],
      ]);
      assert.deepEqual(yield* catalog([], "sol"), [
        ["gpt-6.1-sol", null],
        ["gpt-6-sol", "gpt-6.1-sol"],
      ]);
      // Hiding a successor must not silently make an old version current.
      assert.deepEqual(yield* catalog(["gpt-6.1-sol"]), [["gpt-6-astra", null]]);
      assert.deepEqual(yield* catalog(["gpt-6.1-sol"], "sol"), [["gpt-6-sol", "gpt-6.1-sol"]]);
    }),
  );

  it.effect("accepts an Antigravity model id with a thinking suffix", () =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const task = {
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Survey the kernels.",
        title: null,
        model: "gpt-6-sol",
        status: "running",
        result: null,
        startedAt: null,
        completedAt: null,
      };
      let delegated = false;
      const antigravityId = ProviderInstanceId.make("antigravity");
      const codex = providerSnapshot({
        instanceId: codexInstanceId,
        driver: ProviderDriverKind.make("codex"),
        model: "gpt-6.1-sol",
      });
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? {
                    ...parentProjection(delegated ? [task] : []),
                    thread: {
                      ...parentProjection([]).thread,
                      modelSelection: { instanceId: codexInstanceId, model: "gpt-6-sol" },
                    },
                  }
                : childProjection,
            ),
          isProviderInstanceEnabledForProject: () => Effect.succeed(true),
          assertProviderInstanceEnabled: () => Effect.void,
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  delegated = true;
                }),
              ),
              Effect.as({
                sequence: 1,
                storedEvents: [
                  {
                    sequence: 1,
                    commandId: null,
                    event: { type: "subagent.updated", payload: task },
                  },
                ],
              } as never),
            ),
        }),
        mockProviderRegistry({
          getProviders: Effect.sync(() => [
            codex,
            {
              ...providerSnapshot({
                instanceId: antigravityId,
                driver: ProviderDriverKind.make("antigravity"),
              }),
              models: [
                {
                  slug: "gemini-4-neon",
                  name: "Gemini 4 Neon",
                  isCustom: false,
                  capabilities: {
                    optionDescriptors: [
                      {
                        id: "thought_level",
                        role: "reasoning",
                        label: "Thinking",
                        type: "select",
                        options: [
                          { id: "medium", label: "Medium" },
                          { id: "high", label: "High" },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          ]),
        }),
        adapterRegistryLayer([codexInstanceId, antigravityId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        ServerSettings.layerTest({
          providerModelPreferences: {
            [codexInstanceId]: { hiddenModels: ["gpt-6.1-sol"], modelOrder: [] },
          },
        }),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        // Antigravity 1.3 names a model with its thinking level appended; the agent accepts it.
        const cases = [
          {
            options: undefined,
            expected: [{ id: "thought_level", value: "high" }],
          },
          {
            // An explicit level overrides the suffix.
            options: [{ id: "thought_level", value: "medium" }],
            expected: [{ id: "thought_level", value: "medium" }],
          },
          // Empty options clear the selection, the suffix's included.
          { options: [], expected: [] },
        ];
        for (const [index, { options, expected }] of cases.entries()) {
          yield* service.delegateTask(scope, {
            task: "Survey the kernels.",
            target: {
              providerInstanceId: antigravityId,
              model: "gemini-4-neon-high",
              ...(options === undefined ? {} : { options }),
            },
            mode: "async",
            clientRequestId: `delegate-antigravity-suffix-${index}`,
          });
          const commands = yield* Ref.get(dispatched);
          assert.deepEqual((commands.at(-1) as { modelSelection: unknown }).modelSelection, {
            instanceId: antigravityId,
            model: "gemini-4-neon",
            options: expected,
          });
        }
        const unknownLevel = yield* service
          .delegateTask(scope, {
            task: "Survey the kernels.",
            target: { providerInstanceId: antigravityId, model: "gemini-4-neon-max" },
            mode: "async",
            clientRequestId: "delegate-antigravity-unknown-level",
          })
          .pipe(Effect.flip);
        assert.equal(unknownLevel.code, "model_unavailable");
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("refuses an older model version unless the user named it", () =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const task = {
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Survey the kernels.",
        title: null,
        model: "gpt-6-sol",
        status: "running",
        result: null,
        startedAt: null,
        completedAt: null,
      };
      let delegated = false;
      let pruneOldModel = false;
      let emptyCatalog = false;
      const codex = providerSnapshot({
        instanceId: codexInstanceId,
        driver: ProviderDriverKind.make("codex"),
        model: "gpt-6.1-sol",
      });
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? {
                    ...parentProjection(delegated ? [task] : []),
                    thread: {
                      ...parentProjection([]).thread,
                      modelSelection: { instanceId: codexInstanceId, model: "gpt-6-sol" },
                    },
                  }
                : childProjection,
            ),
          isProviderInstanceEnabledForProject: () => Effect.succeed(true),
          assertProviderInstanceEnabled: () => Effect.void,
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  delegated = true;
                }),
              ),
              Effect.as({
                sequence: 1,
                storedEvents: [
                  {
                    sequence: 1,
                    commandId: null,
                    event: { type: "subagent.updated", payload: task },
                  },
                ],
              } as never),
            ),
        }),
        mockProviderRegistry({
          getProviders: Effect.sync(() => [
            {
              ...codex,
              models: emptyCatalog
                ? []
                : [
                    ...codex.models,
                    ...(!pruneOldModel
                      ? [
                          {
                            slug: "gpt-6-sol",
                            name: "GPT-6-Sol",
                            isCustom: false,
                            capabilities: null,
                          },
                        ]
                      : []),
                    {
                      slug: "gpt-legacy",
                      name: "Legacy",
                      isCustom: false,
                      isLegacy: true,
                      capabilities: null,
                    },
                    {
                      slug: "gpt-gone",
                      name: "Gone",
                      isCustom: false,
                      isLegacy: true,
                      unavailableReason: "Model gpt-gone has been deprecated.",
                      capabilities: null,
                    },
                  ],
              version: "0.130.0",
              updateRequiredModels: [
                { slug: "gpt-7-sol", name: "GPT-7-Sol", minVersion: "0.140.0" },
              ],
            },
            providerSnapshot({
              instanceId: ProviderInstanceId.make("acpRegistry_devin"),
              driver: ProviderDriverKind.make("acpRegistry"),
              model: "swe-2-1-medium",
            }),
          ]),
        }),
        adapterRegistryLayer([codexInstanceId, ProviderInstanceId.make("acpRegistry_devin")]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        ServerSettings.layerTest({
          providerModelPreferences: {
            [codexInstanceId]: { hiddenModels: ["gpt-6.1-sol"], modelOrder: [] },
          },
        }),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const refused = yield* service
          .delegateTask(scope, {
            task: "Survey the kernels.",
            target: { providerInstanceId: codexInstanceId, model: "gpt-6-sol" },
            mode: "async",
            clientRequestId: "delegate-older-model-1",
          })
          .pipe(Effect.flip);
        assert.equal(refused.code, "model_unavailable");
        assert.include(refused.message, "use gpt-6.1-sol");
        assert.equal((yield* Ref.get(dispatched)).length, 0);

        const inherited = yield* service
          .delegateTask(scope, {
            task: "Survey the kernels.",
            mode: "async",
            clientRequestId: "delegate-inherited-older",
          })
          .pipe(Effect.flip);
        assert.equal(inherited.code, "model_unavailable");
        assert.include(inherited.message, "use gpt-6.1-sol");
        const legacy = yield* service
          .delegateTask(scope, {
            task: "Survey the kernels.",
            target: { providerInstanceId: codexInstanceId, model: "gpt-legacy" },
            mode: "async",
            clientRequestId: "delegate-legacy-model",
          })
          .pipe(Effect.flip);
        assert.equal(legacy.code, "model_unavailable");
        assert.include(legacy.message, "concrete valid reason");
        // A model whose provider said it is gone is refused with the provider's words.
        const gone = yield* service
          .delegateTask(scope, {
            task: "Survey the kernels.",
            target: { providerInstanceId: codexInstanceId, model: "gpt-gone" },
            mode: "async",
            clientRequestId: "delegate-gone-model",
          })
          .pipe(Effect.flip);
        assert.equal(gone.code, "model_unavailable");
        assert.include(gone.message, "failed as gone: Model gpt-gone has been deprecated.");
        assert.equal((yield* Ref.get(dispatched)).length, 0);
        const listed = (yield* service.capabilities(scope)).providers[0]!.models;
        assert.notInclude(
          listed.map((model) => model.id),
          "gpt-gone",
        );
        assert.deepInclude(
          (yield* service.capabilities(scope, { modelSearch: "gone" })).providers[0]!.models,
          {
            id: "gpt-gone",
            family: "codex:gone",
            isLegacy: true,
            label: "Gone",
            unavailable: "Model gpt-gone has been deprecated.",
          },
        );
        // A search lists only providers with a match, unless the provider was named.
        assert.deepEqual(
          (yield* service.capabilities(scope, { modelSearch: "no-such-model" })).providers,
          [],
        );
        assert.deepEqual(
          (yield* service.capabilities(scope, {
            providerInstanceId: codexInstanceId,
            modelSearch: "no-such-model",
          })).providers.map((provider) => [provider.providerInstanceId, provider.models]),
          [[codexInstanceId, []]],
        );

        const named = yield* service.delegateTask(scope, {
          task: "Survey the kernels.",
          target: { providerInstanceId: codexInstanceId, model: "gpt-6-sol", userNamedModel: true },
          mode: "async",
          clientRequestId: "delegate-older-model-2",
        });
        assert.equal(named.status, "running");
        const commands = yield* Ref.get(dispatched);
        assert.equal(commands.length, 1);
        assert.equal(
          (commands[0] as { modelSelection: { model: string } }).modelSelection.model,
          "gpt-6-sol",
        );
        pruneOldModel = true;
        const removed = yield* service
          .delegateTask(scope, {
            task: "Survey the kernels.",
            mode: "async",
            clientRequestId: "delegate-pruned-inherited",
          })
          .pipe(Effect.flip);
        assert.equal(removed.code, "model_unavailable");
        assert.include(removed.message, "orchestrator_capabilities");
        assert.include(removed.message, "Advertised: ");
        assert.notInclude(removed.message, "gpt-legacy");
        const prefixed = yield* service
          .delegateTask(scope, {
            task: "Survey the kernels.",
            target: { providerInstanceId: codexInstanceId, model: "openai/gpt-6.1-sol" },
            mode: "async",
            clientRequestId: "delegate-prefixed-model",
          })
          .pipe(Effect.flip);
        assert.equal(prefixed.code, "model_unavailable");
        assert.include(prefixed.message, "Did you mean gpt-6.1-sol?");
        const combinedInstanceModel = yield* service
          .delegateTask(scope, {
            task: "Survey the kernels.",
            target: { model: "acpRegistry_devin/swe-2-1-medium" },
            mode: "async",
            clientRequestId: "delegate-combined-instance-model",
          })
          .pipe(Effect.flip);
        assert.equal(combinedInstanceModel.code, "model_unavailable");
        assert.include(
          combinedInstanceModel.message,
          'Pass target.providerInstanceId: "acpRegistry_devin" and target.model: "swe-2-1-medium" separately.',
        );
        const otherProviderModel = yield* service
          .delegateTask(scope, {
            task: "Survey the kernels.",
            target: { model: "swe-2-1-medium" },
            mode: "async",
            clientRequestId: "delegate-other-provider-model",
          })
          .pipe(Effect.flip);
        assert.equal(otherProviderModel.code, "model_unavailable");
        assert.include(
          otherProviderModel.message,
          `Omitted providerInstanceId inherited ${codexInstanceId}; swe-2-1-medium is on acpRegistry_devin.`,
        );
        const updateRequired = yield* service
          .delegateTask(scope, {
            task: "Survey the kernels.",
            target: { providerInstanceId: codexInstanceId, model: "gpt-7-sol" },
            mode: "async",
            clientRequestId: "delegate-update-required",
          })
          .pipe(Effect.flip);
        assert.equal(updateRequired.code, "model_unavailable");
        assert.include(updateRequired.message, "v0.130.0");
        assert.include(updateRequired.message, "v0.140.0 or newer");
        assert.equal((yield* Ref.get(dispatched)).length, 1);
        emptyCatalog = true;
        const unknown = yield* service
          .delegateTask(scope, {
            task: "Survey the kernels.",
            mode: "async",
            clientRequestId: "delegate-empty-inherited",
          })
          .pipe(Effect.flip);
        assert.equal(unknown.code, "model_unavailable");
        const custom = yield* service.delegateTask(scope, {
          task: "Survey the kernels.",
          target: { model: "my-custom-id", userNamedModel: true },
          mode: "async",
          clientRequestId: "delegate-user-custom",
        });
        assert.equal(custom.status, "running");
        assert.equal((yield* Ref.get(dispatched)).length, 2);
        assert.equal(
          ((yield* Ref.get(dispatched))[1] as { modelSelection: { model: string } }).modelSelection
            .model,
          "my-custom-id",
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect.each(["route", "instance"] as const)(
    "capabilities and delegation agree on family supersession across %s boundaries",
    (boundary) =>
      Effect.gen(function* () {
        const oldModel = "openai/gpt-6-sol";
        const newModel = "openrouter/openai/gpt-6.1-sol";
        const newerInstanceId =
          boundary === "instance" ? ProviderInstanceId.make("z-new") : codexInstanceId;
        const oldProvider = providerSnapshot({
          instanceId: codexInstanceId,
          driver: ProviderDriverKind.make("opencode"),
          model: oldModel,
        });
        const newProvider = providerSnapshot({
          instanceId: newerInstanceId,
          driver: ProviderDriverKind.make("opencode"),
          model: newModel,
        });
        const providers =
          boundary === "instance"
            ? [oldProvider, newProvider]
            : [{ ...oldProvider, models: [...oldProvider.models, ...newProvider.models] }];
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () =>
              Effect.succeed(
                parentProjection([], { instanceId: codexInstanceId, model: oldModel }),
              ),
            hasReceipt: () => Effect.succeed(false),
            isProviderInstanceEnabledForProject: () => Effect.succeed(true),
            dispatch: () => Effect.die("superseded models must not dispatch"),
          }),
          ServerSettings.layerTest(),
          providerRegistryLayer(providers),
          adapterRegistryLayer(providers.map((provider) => provider.instanceId)),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const listed = yield* service.capabilities(scope, {
            providerInstanceId: codexInstanceId,
          });
          assert.notInclude(
            listed.providers[0]!.models.map((model) => model.id),
            oldModel,
          );
          const catalog = yield* service.capabilities(scope, {
            providerInstanceId: codexInstanceId,
            modelSearch: "gpt-6-sol",
          });
          assert.deepInclude(catalog.providers[0]!.models[0], {
            id: oldModel,
            supersededBy: newModel,
            supersededByProviderInstanceId: newerInstanceId,
          });
          const refused = yield* service
            .delegateTask(scope, {
              task: "Review",
              mode: "async",
              clientRequestId: `routed-old-${boundary}`,
            })
            .pipe(Effect.flip);
          assert.equal(refused.code, "model_unavailable");
          assert.include(refused.message, `use ${newModel}`);
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
      }),
  );

  it.effect("gives a recovery route for unadvertised models and mistaken task identifiers", () => {
    const requestId = "review-round";
    const recordedTaskId = NodeId.make(
      `node:delegated-task:${encodeURIComponent(`command:mcp:session:delegate-task:${requestId}`)}`,
    );
    const owned = {
      id: recordedTaskId,
      threadId: parentThreadId,
      origin: "app_owned",
      childThreadId,
    };
    const dependencies = Layer.mergeAll(
      NodeServices.layer,
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        hasReceipt: () => Effect.succeed(false),
        getThreadRecords: (threadId) =>
          Effect.succeed(
            threadId === childThreadId
              ? childProjection
              : parentProjection([
                  owned,
                  { ...owned, id: NodeId.make("native-task-id"), origin: "native" },
                  {
                    ...owned,
                    id: NodeId.make("another-parents-task"),
                    threadId: ThreadId.make("other-parent"),
                  },
                ]),
          ),
        dispatch: () => Effect.die("invalid identifiers must not dispatch"),
      }),
      ServerSettings.layerTest(),
      providerRegistryLayer([
        providerSnapshot({
          instanceId: codexInstanceId,
          driver: ProviderDriverKind.make("codex"),
          model: "current-model",
        }),
      ]),
      adapterRegistryLayer([codexInstanceId]),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    );
    return Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const modelError = yield* service
        .delegateTask(scope, {
          task: "Review the change.",
          target: { providerInstanceId: codexInstanceId, model: "retired-model" },
        })
        .pipe(Effect.flip);
      assert.equal(modelError.code, "model_unavailable");
      assert.include(modelError.message, "orchestrator_capabilities");
      assert.include(modelError.message, "including for inheritance");
      // The clientRequestId the agent chose finds its one task.
      const byRequestId = yield* service.taskStatus(scope, NodeId.make(requestId));
      assert.equal(byRequestId.taskId, taskReference(recordedTaskId));
      const byHandle = yield* service.taskStatus(scope, byRequestId.taskId);
      assert.equal(byHandle.taskId, byRequestId.taskId);
      assert.equal((yield* service.taskStatus(scope, recordedTaskId)).taskId, byHandle.taskId);
      const unknown = yield* service
        .taskStatus(scope, NodeId.make("unknown-task"))
        .pipe(Effect.flip);
      assert.include(unknown.message, `Available taskIds: ${taskReference(recordedTaskId)}`);
      assert.include(unknown.message, "unique clientRequestId");
      assert.include(unknown.message, "t3_thread_read");
      assert.notInclude(unknown.message, "native-task-id");
      assert.notInclude(unknown.message, "another-parents-task");
    }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
  });

  it.effect("shares the parent's folder when a worktree is asked for outside Git", () =>
    Effect.gen(function* () {
      const cwd = "/tmp/parent-without-git";
      const attempted: string[] = [];
      const dispatched: unknown[] = [];
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          resolveCommit: (input) => {
            attempted.push(input.cwd);
            return Effect.fail(new Error("not a git repository") as never);
          },
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          assertProviderInstanceEnabled: () => Effect.void,
          getThreadRecords: () => Effect.succeed(parentProjection([])),
          dispatch: (command) => {
            dispatched.push(command);
            return Effect.fail(new Error("stop after dispatch") as never);
          },
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeed(Option.some({ workspaceRoot: cwd } as never)),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .delegateTask(scope, {
            task: "Review the code.",
            target: { providerInstanceId: codexInstanceId, model: "gpt-5.4" },
            isolation: "worktree",
            mode: "async",
            clientRequestId: "delegate-no-git",
          })
          .pipe(Effect.flip);
        // Nothing to isolate in a folder without Git: the child shares it.
        assert.equal(error.code, "orchestration_error");
        assert.deepEqual(attempted, [cwd]);
        assert.equal(dispatched.length, 1);
        assert.notProperty(dispatched[0], "workspaceStrategy");
      }).pipe(
        Effect.provide(
          layerOrchestratorMcpWithoutScratch.pipe(
            Layer.provide(Layer.mock(UsageLimitSources.UsageLimitSources)({})),
            Layer.provide(layerDependencies),
          ),
        ),
      );
    }),
  );

  it.effect("exposes a failed task's retryable provider failure to its parent", () => {
    const childRunId = RunId.make("run:capacity-task");
    const failure = {
      class: "provider_error" as const,
      code: "serverOverloaded",
      message: "The task is incomplete; retry it or choose another current model.",
      retryable: true,
    };
    const task = {
      id: taskId,
      threadId: parentThreadId,
      origin: "app_owned",
      childThreadId,
      providerInstanceId: codexInstanceId,
      status: "failed",
      result: failure.message,
      completionDelivery: { state: "acknowledged" },
    };
    const dependencies = Layer.mergeAll(
      NodeServices.layer,
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: (threadId) =>
          Effect.succeed(
            threadId === parentThreadId
              ? parentProjection([task])
              : ({
                  ...childProjection,
                  runs: [{ id: childRunId, ordinal: 1, status: "failed", delegatedTaskId: taskId }],
                  turnItems: [{ type: "error", status: "failed", runId: childRunId, failure }],
                } as unknown as OrchestrationV2ThreadProjection),
          ),
      }),
      ServerSettings.layerTest(),
      providerRegistryLayer([]),
      adapterRegistryLayer([]),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    );
    return Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const result = yield* service.taskStatus(scope, taskId);
      assert.equal(result.status, "failed");
      assert.deepEqual(result.failure, failure);
    }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
  });

  it.effect.each([{ withEdits: true, isolation: "shared" as const }, { withEdits: true }])(
    "rejects a parent edits snapshot with shared isolation (%s)",
    (options) => {
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(parentProjection([])),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([]),
        adapterRegistryLayer([]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      return Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .delegateTask(scope, { task: "Work", ...options })
          .pipe(Effect.flip);
        assert.equal(error.code, "invalid_request");
        assert.include(error.message, "already sees parent edits");
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    },
  );

  it.effect.each(["dispatch", "admission"] as const)(
    "removes a parent edits snapshot when delegation is rejected at %s",
    (stage) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectory({ prefix: "t3-parent-edits-" });
        yield* Effect.addFinalizer(() =>
          fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore),
        );
        yield* fs.writeFileString(`${directory}/snapshot.patch`, "edits");
        let dispatches = 0;
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(WorkflowsService.WorkflowsService)({
            delegate: (_threadId, _key, input, _inherited, execute) =>
              execute(
                { ...input },
                undefined,
                stage === "admission"
                  ? () =>
                      Effect.fail(
                        new WorkflowsError({ reason: "start", message: "Admission rejected" }),
                      )
                  : undefined,
              ),
          }),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(UsageLimitSources.UsageLimitSources)({}),
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            discardParentEdits: (path) => fs.remove(path, { recursive: true }).pipe(Effect.orDie),
            captureParentEdits: () =>
              Effect.succeed({
                directory,
                baseCommit: "commit",
                fingerprint: "hash",
                skippedPaths: [],
              }),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: () => Effect.succeed(false),
            getThreadRecords: () => Effect.succeed({ ...parentProjection([]), messages: [] }),
            dispatch: () =>
              Effect.sync(() => {
                dispatches++;
              }).pipe(
                Effect.andThen(
                  Effect.fail(new OrchestratorProjectionError({ threadId: parentThreadId })),
                ),
              ),
          }),
          ServerSettings.layerTest(),
          providerRegistryLayer([
            providerSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "test-model",
            }),
          ]),
          adapterRegistryLayer([codexInstanceId]),
          Layer.mock(ProjectService.ProjectService)({
            getById: () => Effect.succeed(Option.some({ workspaceRoot: "/repo" } as never)),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const error = yield* service
            .delegateTask(scope, {
              task: "Work",
              isolation: "worktree",
              withEdits: true,
              target: { model: "test-model" },
              clientRequestId: "rejected-snapshot",
            })
            .pipe(Effect.flip);
          if (stage === "admission") assert.include(error.message, "Admission rejected");
          assert.equal(dispatches, stage === "admission" ? 0 : 1);
          assert.isFalse(yield* fs.exists(directory));
        }).pipe(
          Effect.provide(layerOrchestratorMcpWithoutScratch.pipe(Layer.provide(dependencies))),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["/accepted-snapshot", "/other-snapshot"])(
    "on interruption retains only the snapshot named by the durable receipt (%s)",
    (committedDirectory) =>
      Effect.gen(function* () {
        const committing = yield* Deferred.make<void>();
        const finishCommit = yield* Deferred.make<void>();
        let discarded = false;
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(UsageLimitSources.UsageLimitSources)({}),
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            captureParentEdits: () =>
              Effect.succeed({
                directory: "/accepted-snapshot",
                baseCommit: "commit",
                fingerprint: "hash",
                skippedPaths: [],
              }),
            discardParentEdits: () =>
              Effect.sync(() => {
                discarded = true;
              }),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: () => Effect.succeed(false),
            getThreadRecords: () => Effect.succeed({ ...parentProjection([]), messages: [] }),
            dispatch: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(committing, undefined);
                yield* Deferred.await(finishCommit);
                return {
                  storedEvents: [
                    {
                      event: {
                        type: "run.created",
                        threadId: childThreadId,
                        payload: {
                          workspacePreparation: {
                            type: "worktree",
                            parentSnapshot: committedDirectory,
                          },
                        },
                      },
                    },
                  ],
                } as never;
              }).pipe(Effect.uninterruptible),
          }),
          ServerSettings.layerTest(),
          providerRegistryLayer([
            providerSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "test-model",
            }),
          ]),
          adapterRegistryLayer([codexInstanceId]),
          Layer.mock(ProjectService.ProjectService)({
            getById: () => Effect.succeed(Option.some({ workspaceRoot: "/repo" } as never)),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const delegation = yield* service
            .delegateTask(scope, {
              task: "Work",
              isolation: "worktree",
              withEdits: true,
              target: { model: "test-model" },
              clientRequestId: "interrupted-snapshot",
            })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(committing);
          delegation.interruptUnsafe();
          yield* Deferred.succeed(finishCommit, undefined);
          yield* Fiber.await(delegation);
          assert.equal(discarded, committedDirectory !== "/accepted-snapshot");
        }).pipe(
          Effect.provide(layerOrchestratorMcpWithoutScratch.pipe(Layer.provide(dependencies))),
        );
      }).pipe(Effect.scoped),
  );

  it.effect("returns the durable request id from ask_user", () => {
    const commands: OrchestrationV2ServerCommand[] = [];
    const dependencies = Layer.mergeAll(
      NodeServices.layer,
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: () => Effect.succeed(parentProjection([])),
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return {} as never;
          }),
      }),
      ServerSettings.layerTest(),
      providerRegistryLayer([]),
      adapterRegistryLayer([]),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    );
    return Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const result = yield* service.askUser(scope, {
        questions: [{ question: "Which target?" }],
        clientRequestId: "ask-id",
      });
      const command = commands[0];
      assert.equal(command?.type, "user_question.ask");
      if (command?.type === "user_question.ask") assert.equal(result.requestId, command.requestId);
    }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
  });

  it.effect.each([
    "pending",
    "saved",
    "file",
    "api_key",
    "declined",
    "cancelled",
    "new",
    "generated",
  ] as const)(
    "request_secret returns immediately and retries idempotently in state %s",
    (state) => {
      const commands: OrchestrationV2ServerCommand[] = [];
      const ref = SecretRef.make(`secret-ref:${"a".repeat(32)}`);
      const projection = parentProjection([]);
      const cardBase = {
        id: TurnItemId.make(
          `turn-item:secret-request:${encodeURIComponent(projection.thread.id)}:secret-id`,
        ),
        threadId: projection.thread.id,
        runId: RunId.make("an-earlier-run"),
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "waiting" as const,
        title: "Test secret",
        startedAt: null,
        completedAt: null,
        updatedAt: projection.updatedAt,
        label: "Test secret",
        reason: "Needed later",
      };
      let card: OrchestrationV2TurnItem | undefined =
        state === "new" || state === "generated"
          ? undefined
          : {
              ...cardBase,
              type: "secret_request",
              secretStatus: state === "file" || state === "api_key" ? "saved" : state,
              ...(state === "file" ? { delivery: "file" as const } : {}),
              ...(state === "api_key" ? { apiKey: { name: ApiKeyName.make("FAKE_API_KEY") } } : {}),
            };
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () =>
            Effect.sync(() => ({ ...projection, turnItems: card ? [card] : [] })),
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command);
              if (command.type === "secret_request.record")
                card = { ...cardBase, ...command, id: command.turnItemId, type: "secret_request" };
              return {} as never;
            }),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([]),
        adapterRegistryLayer([]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({
          savedRef: () => Effect.succeed(Option.some(ref)),
          saveToFile: () => Effect.succeed("/private/tmp/secret-file"),
          fileDeletedAt: () => Effect.succeed("2026-11-12T07:00:00.000Z"),
        }),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      return Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const input = {
          label: "Test secret",
          reason: "Needed later",
          ...(state === "generated" ? {} : { clientRequestId: "secret-id" }),
        };
        const first = yield* service.requestSecret(scope, input);
        const second = yield* service.requestSecret(scope, {
          ...input,
          ...(first.status === "asked" ? { clientRequestId: first.clientRequestId } : {}),
        });
        assert.deepEqual(first, second);
        assert.lengthOf(commands, state === "new" || state === "generated" ? 1 : 0);
        if (state === "generated") {
          assert.equal(first.status, "asked");
          if (first.status === "asked") assert.isNotEmpty(first.clientRequestId);
        } else if (state === "new" || state === "pending")
          assert.include(first, { status: "asked", clientRequestId: "secret-id" });
        else if (state === "file")
          assert.deepEqual(first, {
            status: "saved",
            file: "/private/tmp/secret-file",
            deletedAt: "2026-11-12T07:00:00.000Z",
          });
        else if (state === "api_key") assert.equal(first.status, "api_key_saved");
        else if (state === "saved") assert.deepEqual(first, { status: "saved", secretRef: ref });
        else assert.deepEqual(first, { status: state });
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    },
  );

  it.effect.each([
    { withEdits: false, fromParentWorktree: false },
    { withEdits: true, fromParentWorktree: false },
    { withEdits: false, fromParentWorktree: true },
    { withEdits: false, fromParentWorktree: false, outOfCredit: true },
  ])(
    "delegates from an explicit repository or the parent's worktree %o",
    ({ withEdits, fromParentWorktree, outOfCredit }) =>
      Effect.gen(function* () {
        const repositoryPath = fromParentWorktree
          ? "/worktrees/t3code-fork/t3-parent"
          : "/work/actual-repository";
        const attempted: string[] = [];
        const dispatched: unknown[] = [];
        const prepared: unknown[] = [];
        const task = {
          id: taskId,
          threadId: parentThreadId,
          origin: "app_owned",
          childThreadId,
          providerInstanceId: codexInstanceId,
          status: "running",
          result: null,
        };
        const strategy = {
          type: "worktree",
          baseRef: "local-commit",
          startFromOrigin: false,
          sourcePath: repositoryPath,
          ...(withEdits ? { parentSnapshot: "/snapshot" } : {}),
        };
        let accepted = false;
        let captures = 0;
        let statusChecks = 0;
        const statusCwds: string[] = [];
        const childRunId = RunId.make("run:mcp-repository-child");
        const withParentWorktree = (projection: OrchestrationV2ThreadProjection) =>
          fromParentWorktree
            ? ({
                ...projection,
                thread: { ...projection.thread, worktreePath: repositoryPath },
              } as OrchestrationV2ThreadProjection)
            : projection;
        const creditFailure = {
          kind: "billing_error",
          outOfCredit: true,
          occurredAt: "2026-11-03T00:00:00.000Z",
          message: "Budget exhausted.",
        } as const;
        const creditWarning = formatOutOfCredit(creditFailure);
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            prepareRun: (input) =>
              Effect.sync(() => {
                prepared.push(input);
              }),
          }),
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            captureParentEdits: (cwd) =>
              Effect.sync(() => {
                captures++;
                attempted.push(cwd);
                return {
                  directory: "/snapshot",
                  baseCommit: "local-commit",
                  fingerprint: "fingerprint",
                  skippedPaths: [".env"],
                };
              }),
            execute: (input) =>
              Effect.sync(() => {
                statusChecks++;
                statusCwds.push(input.cwd);
                assert.deepEqual(input.args, ["status", "--porcelain", "--untracked-files=no"]);
                return {
                  exitCode: 0,
                  stdout: " M src/one.ts\nM  src/two.ts\n",
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                } as never;
              }),
            resolveCommit: (input) =>
              Effect.suspend(() => {
                attempted.push(input.cwd);
                // The scratch project root is not a repository.
                if (input.cwd === "/scratch/chat")
                  return Effect.fail(new Error("not a repository") as never);
                assert.equal(input.revision, "HEAD");
                return Effect.succeed({ commitSha: "local-commit" } as never);
              }),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: () => Effect.sync(() => accepted),
            assertProviderInstanceEnabled: () => Effect.void,
            getThreadRecords: (threadId) =>
              Effect.succeed(
                threadId === parentThreadId
                  ? withParentWorktree(parentProjection(accepted ? [task] : []))
                  : childProjection,
              ),
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command);
                accepted = true;
                return {
                  sequence: 1,
                  storedEvents: [
                    { event: { type: "subagent.updated", payload: task } },
                    {
                      event: {
                        type: "run.created",
                        threadId: childThreadId,
                        payload: {
                          id: childRunId,
                          workspacePreparation: strategy,
                        },
                      },
                    },
                  ],
                } as never;
              }),
          }),
          ServerSettings.layerTest(),
          providerRegistryLayer([
            {
              ...providerSnapshot({
                instanceId: codexInstanceId,
                driver: ProviderDriverKind.make("codex"),
                model: "test-model",
              }),
              ...(outOfCredit ? { recentFailure: creditFailure } : {}),
            },
          ]),
          adapterRegistryLayer([codexInstanceId]),
          Layer.mock(ProjectService.ProjectService)({
            getById: () => Effect.succeed(Option.some({ workspaceRoot: "/scratch/chat" } as never)),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          Layer.mock(UsageLimitSources.UsageLimitSources)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const input = {
            task: "Review the repository.",
            ...(fromParentWorktree ? {} : { repositoryPath }),
            isolation: "worktree" as const,
            target: { providerInstanceId: codexInstanceId, model: "test-model" },
            clientRequestId: "explicit-repository",
            withEdits,
          };
          if (outOfCredit) {
            const capability = (yield* service.capabilities(scope)).providers[0]!;
            assert.deepEqual(capability.accountUnavailable, { reason: creditWarning });
            assert.isFalse(capability.canRunChildTask);
          }
          const result = yield* service.delegateTask(scope, input);
          assert.equal(result.taskId, taskReference(taskId));
          if (withEdits) {
            assert.include(result.notice, "parent's edits");
            assert.include(result.notice, ".env");
          } else {
            assert.equal(
              result.notice,
              `${outOfCredit ? `${creditWarning} ` : ""}2 uncommitted files stayed behind; withEdits:true includes them.`,
            );
          }
          assert.equal(captures, withEdits ? 1 : 0);
          assert.equal(statusChecks, withEdits ? 0 : 1);
          assert.deepEqual(statusCwds, withEdits ? [] : [repositoryPath]);
          const checked = fromParentWorktree ? [repositoryPath, "/scratch/chat"] : [repositoryPath];
          assert.deepEqual(attempted, checked);
          assert.deepInclude(dispatched[0], { workspaceStrategy: strategy });
          assert.deepEqual(prepared, [
            {
              commandId: (dispatched[0] as { commandId: string }).commandId,
              threadId: childThreadId,
              runId: childRunId,
            },
          ]);
          // Receipt replay must not inspect a repository that may since have moved.
          yield* service.delegateTask(scope, input);
          assert.deepEqual(attempted, checked);
          assert.equal(captures, withEdits ? 1 : 0);
          assert.equal(statusChecks, withEdits ? 0 : 1);
        }).pipe(
          Effect.provide(layerOrchestratorMcpWithoutScratch.pipe(Layer.provide(layerDependencies))),
        );
      }),
  );

  it.effect.each(["clean", "one-file", "check-fails"] as const)(
    "reports leftover tracked edits only when there are any (%s)",
    (kind) =>
      Effect.gen(function* () {
        const dispatched: unknown[] = [];
        const task = {
          id: taskId,
          threadId: parentThreadId,
          origin: "app_owned",
          childThreadId,
          providerInstanceId: codexInstanceId,
          status: "running",
          result: null,
        };
        let accepted = false;
        const childRunId = RunId.make("run:mcp-leftover-edits-child");
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            prepareRun: () => Effect.void,
          }),
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            resolveCommit: () => Effect.succeed({ commitSha: "local-commit" } as never),
            execute: () =>
              kind === "check-fails"
                ? Effect.fail(new Error("git unavailable") as never)
                : Effect.succeed({
                    exitCode: 0,
                    stdout: kind === "one-file" ? " M src/only.ts\n" : "",
                    stderr: "",
                    stdoutTruncated: false,
                    stderrTruncated: false,
                  } as never),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: () => Effect.sync(() => accepted),
            assertProviderInstanceEnabled: () => Effect.void,
            getThreadRecords: (threadId) =>
              Effect.succeed(
                threadId === parentThreadId
                  ? parentProjection(accepted ? [task] : [])
                  : childProjection,
              ),
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command);
                accepted = true;
                return {
                  sequence: 1,
                  storedEvents: [
                    { event: { type: "subagent.updated", payload: task } },
                    {
                      event: {
                        type: "run.created",
                        threadId: childThreadId,
                        payload: {
                          id: childRunId,
                          workspacePreparation: {
                            type: "worktree",
                            baseRef: "local-commit",
                            startFromOrigin: false,
                          },
                        },
                      },
                    },
                  ],
                } as never;
              }),
          }),
          ServerSettings.layerTest(),
          providerRegistryLayer([
            providerSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "test-model",
            }),
          ]),
          adapterRegistryLayer([codexInstanceId]),
          Layer.mock(ProjectService.ProjectService)({
            getById: () => Effect.succeed(Option.some({ workspaceRoot: "/work/repo" } as never)),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          Layer.mock(UsageLimitSources.UsageLimitSources)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const result = yield* service.delegateTask(scope, {
            task: "Review.",
            isolation: "worktree",
            target: { providerInstanceId: codexInstanceId, model: "test-model" },
            clientRequestId: `leftover-edits-${kind}`,
          });
          if (kind === "one-file") {
            assert.equal(
              result.notice,
              "1 uncommitted file stayed behind; withEdits:true includes them.",
            );
          } else {
            // Clean checkouts stay quiet, and a failed check never blocks the child.
            assert.isUndefined(result.notice);
          }
          assert.equal(dispatched.length, 1);
        }).pipe(
          Effect.provide(layerOrchestratorMcpWithoutScratch.pipe(Layer.provide(layerDependencies))),
        );
      }),
  );

  it.effect.each([
    { repositoryPath: "relative/repo", isolation: "worktree" as const },
    { repositoryPath: "relative/repo", isolation: "shared" as const },
  ])("rejects a relative repository override before dispatch", (input) => {
    const dependencies = Layer.mergeAll(
      NodeServices.layer,
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        hasReceipt: () => Effect.succeed(false),
        assertProviderInstanceEnabled: () => Effect.void,
        getThreadRecords: () => Effect.succeed(parentProjection([])),
        dispatch: () => Effect.die("invalid repository override must not dispatch"),
      }),
      ServerSettings.layerTest(),
      providerRegistryLayer([
        providerSnapshot({
          instanceId: codexInstanceId,
          driver: ProviderDriverKind.make("codex"),
          model: "test-model",
        }),
      ]),
      adapterRegistryLayer([codexInstanceId]),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    );
    return Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const error = yield* service
        .delegateTask(scope, {
          ...input,
          task: "Review.",
          target: { providerInstanceId: codexInstanceId, model: "test-model" },
        })
        .pipe(Effect.flip);
      assert.equal(error.code, "invalid_request");
      assert.include(error.message, "absolute path");
    }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
  });

  it.effect("runs a shared child in the folder repositoryPath names", () => {
    const dispatched: unknown[] = [];
    const dependencies = Layer.mergeAll(
      NodeServices.layer,
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        hasReceipt: () => Effect.succeed(false),
        assertProviderInstanceEnabled: () => Effect.void,
        getThreadRecords: () => Effect.succeed(parentProjection([])),
        dispatch: (command) => {
          dispatched.push(command);
          return Effect.fail(new Error("stop after dispatch") as never);
        },
      }),
      ServerSettings.layerTest(),
      providerRegistryLayer([
        providerSnapshot({
          instanceId: codexInstanceId,
          driver: ProviderDriverKind.make("codex"),
          model: "test-model",
        }),
      ]),
      adapterRegistryLayer([codexInstanceId]),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    );
    return Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      yield* service
        .delegateTask(scope, {
          repositoryPath: "/work/repo",
          isolation: "shared",
          task: "Review.",
          target: { providerInstanceId: codexInstanceId, model: "test-model" },
        })
        .pipe(Effect.flip);
      assert.deepEqual((dispatched[0] as { workspaceStrategy?: unknown }).workspaceStrategy, {
        type: "existing_worktree",
        worktreePath: "/work/repo",
      });
    }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
  });

  it.effect(
    "delegates to an Antigravity instance whose adapter resolves through the registry",
    () =>
      Effect.gen(function* () {
        let delegated = false;
        const task = {
          id: taskId,
          threadId: parentThreadId,
          runId: parentRunId,
          parentNodeId,
          origin: "app_owned",
          createdBy: "agent",
          driver: ProviderDriverKind.make("antigravity"),
          providerInstanceId: antigravityInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Summarize the diff.",
          title: null,
          model: "ant-model",
          status: "running",
          result: null,
          startedAt: null,
          completedAt: null,
        };
        const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: () => Effect.succeed(false),
            assertProviderInstanceEnabled: () => Effect.void,
            getThreadRecords: (threadId) =>
              Effect.succeed(
                threadId === parentThreadId
                  ? parentProjection(delegated ? [task] : [])
                  : childProjection,
              ),
            dispatch: (command) =>
              Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    delegated = true;
                  }),
                ),
                Effect.as({
                  sequence: 1,
                  storedEvents: [
                    {
                      sequence: 1,
                      commandId: null,
                      event: { type: "subagent.updated", payload: task },
                    },
                  ],
                } as never),
              ),
          }),
          ServerSettings.layerTest(),
          mockProviderRegistry({
            getProviders: Effect.succeed([
              providerSnapshot({
                instanceId: codexInstanceId,
                driver: ProviderDriverKind.make("codex"),
                model: "gpt-5.4",
              }),
              providerSnapshot({
                instanceId: antigravityInstanceId,
                driver: ProviderDriverKind.make("antigravity"),
                model: "ant-model",
              }),
            ]),
          }),
          adapterRegistryLayer([codexInstanceId, antigravityInstanceId]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const result = yield* service.delegateTask(scope, {
            task: "Summarize the diff.",
            target: { providerInstanceId: antigravityInstanceId, model: "ant-model" },
            mode: "async",
            clientRequestId: "delegate-antigravity-1",
          });
          assert.equal(result.status, "running");
          assert.equal(result.providerInstanceId, antigravityInstanceId);
          const commands = yield* Ref.get(dispatched);
          assert.equal(commands.length, 1);
          const request = commands[0] as {
            type: string;
            modelSelection: { instanceId: string; model: string };
          };
          assert.equal(request.type, "delegated_task.request");
          assert.equal(request.modelSelection.instanceId, antigravityInstanceId);
          assert.equal(request.modelSelection.model, "ant-model");
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }),
  );

  it.effect("resolves a driverKind target to a capable Antigravity instance", () =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const task = {
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("antigravity"),
        providerInstanceId: antigravityInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Summarize the diff.",
        title: null,
        model: "ant-model",
        status: "running",
        result: null,
        startedAt: null,
        completedAt: null,
      };
      let delegated = false;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          assertProviderInstanceEnabled: () => Effect.void,
          isProviderInstanceEnabledForProject: () => Effect.succeed(true),
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? parentProjection(delegated ? [task] : [])
                : childProjection,
            ),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  delegated = true;
                }),
              ),
              Effect.as({
                sequence: 1,
                storedEvents: [
                  {
                    sequence: 1,
                    commandId: null,
                    event: { type: "subagent.updated", payload: task },
                  },
                ],
              } as never),
            ),
        }),
        ServerSettings.layerTest({
          providerInstances: {
            [antigravityInstanceId]: {
              driver: ProviderDriverKind.make("antigravity"),
              enabled: true,
              config: {},
            },
          },
        }),
        mockProviderRegistry({
          getProviders: Effect.succeed([
            providerSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
            }),
            providerSnapshot({
              instanceId: antigravityInstanceId,
              driver: ProviderDriverKind.make("antigravity"),
              model: "ant-model",
            }),
          ]),
        }),
        adapterRegistryLayer([codexInstanceId, antigravityInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.delegateTask(scope, {
          task: "Summarize the diff.",
          target: { driverKind: ProviderDriverKind.make("antigravity") },
          mode: "async",
          clientRequestId: "delegate-antigravity-driver-1",
        });
        assert.equal(result.status, "running");
        const commands = yield* Ref.get(dispatched);
        assert.equal(commands.length, 1);
        const request = commands[0] as {
          modelSelection: { instanceId: string; model: string };
        };
        assert.equal(request.modelSelection.instanceId, antigravityInstanceId);
        assert.equal(request.modelSelection.model, "ant-model");
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("rejects delegation to a provider without a registered adapter", () =>
    Effect.gen(function* () {
      const forkOnlyInstanceId = ProviderInstanceId.make("forkOnly");
      const forkShadow = yield* buildUnavailableProviderSnapshot({
        driverKind: "forkOnly",
        instanceId: forkOnlyInstanceId,
        reason: "Driver 'forkOnly' is not registered in this build.",
        checkedAt: "2026-09-13T00:00:00.000Z",
      });
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: () => Effect.succeed(parentProjection([])),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          forkShadow,
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const byInstance = yield* service
          .delegateTask(scope, {
            task: "Summarize the diff.",
            target: { providerInstanceId: forkOnlyInstanceId },
            mode: "async",
            clientRequestId: "delegate-fork-1",
          })
          .pipe(Effect.flip);
        assert.equal(byInstance.code, "provider_unavailable");
        assert.isTrue(byInstance.message.includes("No V2 provider adapter is registered."));

        const byDriver = yield* service
          .delegateTask(scope, {
            task: "Summarize the diff.",
            target: { driverKind: ProviderDriverKind.make("forkOnly") },
            mode: "async",
            clientRequestId: "delegate-fork-2",
          })
          .pipe(Effect.flip);
        assert.equal(byDriver.code, "provider_unavailable");
        assert.isTrue(
          byDriver.message.includes("No V2 provider adapter is registered for driver forkOnly."),
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("refuses delegation to a provider the project turned off", () =>
    Effect.gen(function* () {
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: () => Effect.succeed(parentProjection([])),
          // ThreadManagementService.dispatch is the chokepoint now: it is the
          // one that refuses, not a separate pre-dispatch assert.
          dispatch: () =>
            Effect.fail(
              new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                projectId,
                instanceId: codexInstanceId,
              }),
            ),
        }),
        providerRegistryLayer([
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        ServerSettings.layerTest(),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .delegateTask(scope, {
            task: "Summarize the diff.",
            target: { providerInstanceId: codexInstanceId },
            mode: "async",
            clientRequestId: "delegate-disabled-1",
          })
          .pipe(Effect.flip);
        assert.equal(error.code, "invalid_request");
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("driver-only delegation skips an instance the project turned off", () =>
    Effect.gen(function* () {
      const altInstanceId = ProviderInstanceId.make("codex-alt");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const task = {
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: altInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Summarize the diff.",
        title: null,
        model: "gpt-5.4",
        status: "running",
        result: null,
        startedAt: null,
        completedAt: null,
      };
      let delegated = false;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? parentProjection(delegated ? [task] : [])
                : childProjection,
            ),
          // The parent's own instance is off for this project; the other
          // instance of the same driver is on.
          isProviderInstanceEnabledForProject: ({ instanceId }) =>
            Effect.succeed(instanceId !== codexInstanceId),
          assertProviderInstanceEnabled: ({ projectId, instanceId }) =>
            instanceId === codexInstanceId
              ? Effect.fail(
                  new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                    projectId,
                    instanceId,
                  }),
                )
              : Effect.void,
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  delegated = true;
                }),
              ),
              Effect.as({
                sequence: 1,
                storedEvents: [
                  {
                    sequence: 1,
                    commandId: null,
                    event: { type: "subagent.updated", payload: task },
                  },
                ],
              } as never),
            ),
        }),
        providerRegistryLayer([
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          providerSnapshot({
            instanceId: altInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
        ]),
        adapterRegistryLayer([codexInstanceId, altInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        ServerSettings.layerTest({
          providerInstances: {
            [altInstanceId]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              config: {},
            },
          },
        }),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.delegateTask(scope, {
          task: "Summarize the diff.",
          target: { driverKind: ProviderDriverKind.make("codex") },
          mode: "async",
          clientRequestId: "delegate-driver-skip-disabled-1",
        });
        assert.equal(result.status, "running");
        const commands = yield* Ref.get(dispatched);
        assert.equal(commands.length, 1);
        const request = commands[0] as {
          modelSelection: { instanceId: string; model: string };
        };
        assert.equal(request.modelSelection.instanceId, altInstanceId);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("retrying an accepted delegation replays after its provider and model disappear", () =>
    Effect.gen(function* () {
      const altInstanceId = ProviderInstanceId.make("codex-alt");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const accepted = yield* Ref.make(false);
      const everyCandidateDisabled = yield* Ref.make(false);
      const task = {
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Summarize the diff.",
        title: null,
        model: "gpt-5.4",
        status: "running",
        result: null,
        startedAt: null,
        completedAt: null,
      };
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Ref.get(accepted).pipe(
              Effect.map((isAccepted) =>
                threadId === parentThreadId
                  ? parentProjection(isAccepted ? [task] : [])
                  : childProjection,
              ),
            ),
          // A command id already accepted once, even if the project later
          // disables every candidate: its retry must replay, not re-resolve.
          hasReceipt: () => Ref.get(accepted),
          // Effective settings once the project turns every instance off,
          // ignoring the already-accepted command's replay exemption.
          isProviderInstanceEnabledForProject: () =>
            Ref.get(everyCandidateDisabled).pipe(Effect.map((disabled) => !disabled)),
          assertProviderInstanceEnabled: ({ projectId, instanceId }) =>
            Effect.all([Ref.get(accepted), Ref.get(everyCandidateDisabled)]).pipe(
              Effect.flatMap(([isAccepted, disabled]) =>
                isAccepted || !disabled
                  ? Effect.void
                  : Effect.fail(
                      new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                        projectId,
                        instanceId,
                      }),
                    ),
              ),
            ),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(Ref.set(accepted, true)),
              Effect.as({
                sequence: 1,
                storedEvents: [
                  {
                    sequence: 1,
                    commandId: null,
                    event: { type: "subagent.updated", payload: task },
                  },
                ],
              } as never),
            ),
        }),
        mockProviderRegistry({
          getProviders: Ref.get(everyCandidateDisabled).pipe(
            Effect.map((disabled) =>
              disabled
                ? []
                : [
                    providerSnapshot({
                      instanceId: codexInstanceId,
                      driver: ProviderDriverKind.make("codex"),
                      model: "gpt-5.4",
                    }),
                    providerSnapshot({
                      instanceId: altInstanceId,
                      driver: ProviderDriverKind.make("codex"),
                      model: "gpt-5.4",
                    }),
                  ],
            ),
          ),
        }),
        adapterRegistryLayer([codexInstanceId, altInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        ServerSettings.layerTest(),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const first = yield* service.delegateTask(scope, {
          task: "Summarize the diff.",
          target: { driverKind: ProviderDriverKind.make("codex") },
          mode: "async",
          clientRequestId: "delegate-driver-retry-after-disable-1",
        });
        assert.equal(first.status, "running");

        // The project turns off every instance of this driver only after
        // the delegation above was already accepted.
        yield* Ref.set(everyCandidateDisabled, true);

        const retry = yield* service.delegateTask(scope, {
          task: "Summarize the diff.",
          target: { driverKind: ProviderDriverKind.make("codex") },
          mode: "async",
          clientRequestId: "delegate-driver-retry-after-disable-1",
        });
        assert.equal(retry.status, "running");

        const commands = yield* Ref.get(dispatched);
        assert.equal(commands.length, 2);
        const retryCommand = commands[1] as {
          modelSelection: { instanceId: string; model: string };
        };
        assert.equal(retryCommand.modelSelection.instanceId, codexInstanceId);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("re-probes an unavailable target once before refusing it", () =>
    Effect.gen(function* () {
      const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
      const claudeDriver = ProviderDriverKind.make("claudeAgent");
      const task = {
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver: claudeDriver,
        providerInstanceId: claudeInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Review the diff.",
        title: null,
        model: "claude-opus-5-5",
        status: "running",
        result: null,
        startedAt: null,
        completedAt: null,
      };
      const healthy = providerSnapshot({
        instanceId: claudeInstanceId,
        driver: claudeDriver,
        model: "claude-opus-5-5",
      });
      const missingCli: ServerProvider = {
        ...healthy,
        installed: false,
        status: "error",
        message: "Claude Agent CLI (`claude`) was not found on PATH.",
      };
      const codex = providerSnapshot({
        instanceId: codexInstanceId,
        driver: ProviderDriverKind.make("codex"),
        model: "gpt-5.4",
      });
      // The cache still says the CLI is missing; a probe reports `cliInstalled`.
      let cliInstalled = false;
      const probes = yield* Ref.make(0);
      const dispatched = yield* Ref.make(0);
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          assertProviderInstanceEnabled: () => Effect.void,
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId ? parentProjection([task]) : childProjection,
            ),
          dispatch: () =>
            Ref.update(dispatched, (count) => count + 1).pipe(
              Effect.as({
                sequence: 1,
                storedEvents: [
                  {
                    sequence: 1,
                    commandId: null,
                    event: { type: "subagent.updated", payload: task },
                  },
                ],
              } as never),
            ),
        }),
        ServerSettings.layerTest(),
        mockProviderRegistry({
          getProviders: Effect.succeed([codex, missingCli]),
          refreshInstance: () =>
            Ref.update(probes, (count) => count + 1).pipe(
              Effect.as([codex, cliInstalled ? healthy : missingCli]),
            ),
        }),
        adapterRegistryLayer([codexInstanceId, claudeInstanceId]),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const delegate = (clientRequestId: string) =>
          service.delegateTask(scope, {
            task: "Review the diff.",
            target: { providerInstanceId: claudeInstanceId, model: "claude-opus-5-5" },
            mode: "async",
            clientRequestId,
          });

        const error = yield* delegate("delegate-recheck-1").pipe(Effect.flip);
        assert.equal(error.code, "provider_unavailable");
        assert.equal(yield* Ref.get(probes), 1);
        assert.equal(yield* Ref.get(dispatched), 0);

        cliInstalled = true;
        const result = yield* delegate("delegate-recheck-2");
        assert.equal(result.providerInstanceId, claudeInstanceId);
        assert.equal(yield* Ref.get(probes), 2);
        assert.equal(yield* Ref.get(dispatched), 1);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect(
    "inherits an available parent instance for driver-only targets and otherwise selects a healthy peer",
    () =>
      Effect.gen(function* () {
        const codexAltInstanceId = ProviderInstanceId.make("codex-alt");
        const driver = ProviderDriverKind.make("codex");
        const claudeDriver = ProviderDriverKind.make("claudeAgent");
        const parentModelSelection = {
          instanceId: codexInstanceId,
          model: "gpt-5.4",
          options: [{ id: "reasoningEffort", value: "high" }],
        } as const;
        const task = {
          id: taskId,
          threadId: parentThreadId,
          runId: parentRunId,
          parentNodeId,
          origin: "app_owned",
          createdBy: "agent",
          driver,
          providerInstanceId: codexInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Summarize the diff.",
          title: null,
          model: "gpt-5.4",
          status: "running",
          result: null,
          startedAt: null,
          completedAt: null,
        };
        const cases = [
          {
            name: "healthy-inherited",
            inheritedEnabled: true,
            peerEnabled: true,
            explicit: false,
            selectedInstanceId: codexInstanceId,
            candidateDriver: driver,
          },
          {
            name: "account-unavailable-inherited-falls-back-to-healthy-peer",
            inheritedEnabled: true,
            peerEnabled: true,
            explicit: false,
            selectedInstanceId: codexAltInstanceId,
            candidateDriver: driver,
          },
          {
            name: "unavailable-inherited-falls-back-to-healthy-peer",
            inheritedEnabled: false,
            peerEnabled: true,
            explicit: false,
            selectedInstanceId: codexAltInstanceId,
            candidateDriver: driver,
          },
          {
            name: "no-available-peer",
            inheritedEnabled: false,
            peerEnabled: false,
            explicit: false,
            selectedInstanceId: null,
            candidateDriver: driver,
          },
          {
            name: "cross-driver-no-available-candidate",
            inheritedEnabled: false,
            peerEnabled: false,
            explicit: false,
            selectedInstanceId: null,
            candidateDriver: claudeDriver,
          },
          {
            name: "explicit-unavailable",
            inheritedEnabled: false,
            peerEnabled: true,
            explicit: true,
            selectedInstanceId: null,
            candidateDriver: driver,
          },
          {
            name: "explicit-healthy",
            inheritedEnabled: true,
            peerEnabled: true,
            explicit: true,
            selectedInstanceId: codexAltInstanceId,
            candidateDriver: driver,
          },
        ] as const;

        for (const testCase of cases) {
          const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
          let delegated = false;
          const layerDependencies = Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              hasReceipt: () => Effect.succeed(false),
              getThreadEventSequence: () => Effect.succeed(0),
              assertProviderInstanceEnabled: () => Effect.void,
              isProviderInstanceEnabledForProject: () => Effect.succeed(true),
              getThreadRecords: (threadId) =>
                Effect.succeed(
                  threadId === parentThreadId
                    ? parentProjection(delegated ? [task] : [], parentModelSelection)
                    : childProjection,
                ),
              dispatch: (command) =>
                Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      delegated = true;
                    }),
                  ),
                  Effect.as({
                    sequence: 1,
                    storedEvents: [
                      {
                        sequence: 1,
                        commandId: null,
                        event: { type: "subagent.updated", payload: task },
                      },
                    ],
                  } as never),
                ),
            }),
            ServerSettings.layerTest({
              balanceAccounts: true,
              providerInstances: {
                [codexAltInstanceId]: {
                  driver: testCase.candidateDriver,
                  enabled: true,
                  config: {},
                },
              },
            }),
            providerRegistryLayer([
              {
                ...providerSnapshot({
                  instanceId: codexInstanceId,
                  driver,
                  model: "gpt-5.4",
                  enabled: testCase.inheritedEnabled,
                }),
                ...(testCase.name === "account-unavailable-inherited-falls-back-to-healthy-peer"
                  ? {
                      recentFailure: {
                        kind: "billing_error" as const,
                        message: "Budget exhausted.",
                        occurredAt: "2000-01-01T00:00:00.000Z",
                        resetAt: "2999-01-01T00:00:00.000Z",
                      },
                    }
                  : {}),
              },
              providerSnapshot({
                instanceId: codexAltInstanceId,
                driver: testCase.candidateDriver,
                model: "codex-alt-model",
                enabled: testCase.peerEnabled,
              }),
            ]),
            adapterRegistryLayer([codexInstanceId, codexAltInstanceId]),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          );

          yield* Effect.gen(function* () {
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const target = testCase.explicit
              ? ({
                  providerInstanceId:
                    testCase.selectedInstanceId === null
                      ? codexInstanceId
                      : testCase.selectedInstanceId,
                } as const)
              : ({ driverKind: testCase.candidateDriver } as const);
            if (testCase.selectedInstanceId === null) {
              const error = yield* service
                .delegateTask(scope, {
                  task: "Summarize the diff.",
                  target,
                  mode: "async",
                  clientRequestId: `delegate-select-${testCase.name}`,
                })
                .pipe(Effect.flip);
              assert.equal(error.code, "provider_unavailable", testCase.name);
              if (testCase.name === "cross-driver-no-available-candidate") {
                assert.isTrue(error.message.includes("driver claudeAgent"), testCase.name);
                const threadError = yield* service
                  .createThreads(scope, {
                    threads: [{ prompt: "Summarize the diff.", target }],
                    clientRequestId: `delegate-threads-${testCase.name}`,
                  })
                  .pipe(Effect.flip);
                assert.equal(
                  threadError.code,
                  "provider_unavailable",
                  `${testCase.name}-createThreads`,
                );
                assert.isTrue(
                  threadError.message.includes("driver claudeAgent"),
                  `${testCase.name}-createThreads`,
                );
              }
              assert.deepEqual(yield* Ref.get(dispatched), [], testCase.name);
              return;
            }
            const result = yield* service.delegateTask(scope, {
              task: "Summarize the diff.",
              target,
              mode: "async",
              clientRequestId: `delegate-select-${testCase.name}`,
            });
            assert.equal(result.status, "running", testCase.name);
            const commands = yield* Ref.get(dispatched);
            assert.equal(commands.length, 1, testCase.name);
            const request = commands[0] as {
              type: string;
              modelSelection: {
                instanceId: string;
                model: string;
                options?: ReadonlyArray<{ id: string; value: unknown }>;
              };
            };
            assert.equal(request.type, "delegated_task.request", testCase.name);
            assert.equal(
              request.modelSelection.instanceId,
              testCase.selectedInstanceId,
              testCase.name,
            );
            if (testCase.name === "healthy-inherited") {
              assert.deepEqual(request.modelSelection, parentModelSelection, testCase.name);
            } else {
              assert.equal(request.modelSelection.model, "codex-alt-model", testCase.name);
            }
          }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
        }
      }),
  );

  describe("scheduled tasks at modes above the caller's", () => {
    const projectId = ProjectId.make("project:scheduled");
    const boundThreadId = ThreadId.make("thread:scheduled-bound");
    const task = (overrides: Partial<ScheduledTask>): ScheduledTask => ({
      id: ScheduledTaskId.make("scheduled-task:webhook"),
      title: "On push",
      prompt: "Do {{body.instruction}}",
      enabled: true,
      schedule: { type: "webhook", signature: null },
      projectId,
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
      createdAt: "2026-10-05T00:00:00.000Z",
      updatedAt: "2026-10-05T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunError: null,
      runCount: 0,
      webhook: {
        path: "/hooks/scheduled-task/secret",
        url: "https://t3.example/hooks/secret",
        hasSecret: false,
      },
      ...overrides,
    });
    const supervisedClient: McpInvocationScope = {
      environmentId: EnvironmentId.make("environment:scheduled"),
      requestNamespace: "client:scheduled",
      thread: undefined,
      client: {
        sessionId: "scheduled",
        label: "Claude Code",
        access: "approval-required",
      },
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
    };
    const service = (
      tasks: ReadonlyArray<ScheduledTask>,
      boundThread: OrchestrationV2ThreadShell | null,
      upserted: Ref.Ref<number>,
    ) =>
      layerOrchestratorService.pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: (threadId) =>
                Effect.succeed(threadId === boundThreadId ? boundThread : null),
            }),
            ServerSettings.layerTest(),
            mockProviderRegistry({ getProviders: Effect.succeed([]) }),
            Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
              list: () => Effect.succeed([]),
            }),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({
              list: () => Effect.succeed({ tasks }),
              upsert: () =>
                Ref.update(upserted, (count) => count + 1).pipe(Effect.as({ task: tasks[0]! })),
            }),
          ),
        ),
      );

    it.effect.each([
      { type: "root" },
      { type: "existing_worktree", worktreePath: "/worktrees/saved", branch: "saved" },
      { type: "worktree", baseRef: "release", startFromOrigin: false },
    ] as const)(
      "keeps a saved $type checkout when an edit keeps its binding",
      (workspaceStrategy) =>
        Effect.gen(function* () {
          let stored = task({ workspaceStrategy });
          const parentShell = {
            ...liveThreadShell(boundThreadId, { runtimeMode: "approval-required" }),
            projectId,
          };
          const parent = idleThreadProjection(parentShell);
          const dependencies = Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadRecords: () => Effect.succeed(parent),
              getThreadShell: () => Effect.succeed(parentShell),
            }),
            ServerSettings.layerTest(),
            mockProviderRegistry({ getProviders: Effect.succeed([]) }),
            Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
              list: () => Effect.succeed([]),
            }),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({
              list: () => Effect.sync(() => ({ tasks: [stored] })),
              upsert: (input) =>
                Effect.sync(() => {
                  stored = {
                    ...stored,
                    prompt: input.prompt,
                    workspaceStrategy: input.workspaceStrategy,
                    threadId: input.threadId ?? null,
                  };
                  return { task: stored };
                }),
            }),
          );
          yield* Effect.gen(function* () {
            const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
            yield* mcp.updateScheduledTask(supervisedClient, {
              scheduledTaskId: stored.id,
              prompt: "Edited",
              bindToCurrentThread: false,
            });
            assert.deepEqual(stored.workspaceStrategy, workspaceStrategy);
            stored = { ...stored, threadId: boundThreadId };
            yield* mcp.updateScheduledTask(
              {
                ...supervisedClient,
                client: undefined,
                thread: {
                  threadId: boundThreadId,
                  providerSessionId: "provider:scheduled",
                  providerInstanceId: ProviderInstanceId.make("codex"),
                },
              },
              { scheduledTaskId: stored.id, bindToCurrentThread: true },
            );
            assert.deepEqual(stored.workspaceStrategy, workspaceStrategy);
            yield* mcp.updateScheduledTask(supervisedClient, {
              scheduledTaskId: stored.id,
              bindToCurrentThread: false,
            });
            assert.deepEqual(stored.workspaceStrategy, {
              type: "worktree",
              baseRef: "main",
              startFromOrigin: true,
            });
          }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
        }),
    );

    it.effect("lists webhook tasks without their URLs, filtered by id", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const supervised = ScheduledTaskId.make("scheduled-task:supervised");
        const [listed, one] = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) =>
            Effect.all([
              mcp.listScheduledTasks(supervisedClient, { projectId }),
              mcp.listScheduledTasks(supervisedClient, { projectId, scheduledTaskId: supervised }),
            ]),
          ),
          Effect.provide(
            service(
              [task({ runtimeMode: "full-access" }), task({ id: supervised })],
              null,
              upserted,
            ),
          ),
        );
        // Even a caller allowed to run the task gets no bearer URL from a list.
        assert.deepEqual(
          listed.tasks.map((summary) => summary.webhookUrl),
          [undefined, undefined],
        );
        assert.deepEqual(
          one.tasks.map((summary) => summary.scheduledTaskId),
          [supervised],
        );
      }),
    );

    it.effect("delivers webhook setup mechanics when reading a specific webhook task", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const webhookTask = task({});
        const intervalTask = task({
          id: ScheduledTaskId.make("scheduled-task:interval"),
          schedule: { type: "interval", everyMs: 3_600_000 },
          webhook: undefined,
        });
        const [listed, webhookDetail, intervalDetail] =
          yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
            Effect.flatMap((mcp) =>
              Effect.all([
                mcp.listScheduledTasks(supervisedClient, { projectId }),
                mcp.listScheduledTasks(supervisedClient, {
                  projectId,
                  scheduledTaskId: webhookTask.id,
                }),
                mcp.listScheduledTasks(supervisedClient, {
                  projectId,
                  scheduledTaskId: intervalTask.id,
                }),
              ]),
            ),
            Effect.provide(service([webhookTask, intervalTask], null, upserted)),
          );
        assert.isTrue(listed.tasks.every((entry) => entry.webhookSetup === undefined));
        const webhook = webhookDetail.tasks[0];
        const interval = intervalDetail.tasks[0];
        assert.include(webhook?.webhookSetup ?? "", "{{body.path}}");
        assert.include(webhook?.webhookSetup ?? "", "{{request}} (method, redacted headers, body)");
        assert.include(webhook?.webhookSetup ?? "", "request_secret");
        assert.isUndefined(interval?.webhookSetup);
      }),
    );

    it.effect("hides a webhook URL from a thread whose turn has ended", () =>
      Effect.gen(function* () {
        const callerId = ThreadId.make("thread:scheduled-ended");
        const shell = liveThreadShell(callerId, { activeRunId: null });
        const listed = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) =>
            mcp.listScheduledTasks(
              {
                ...supervisedClient,
                requestNamespace: "provider:scheduled-ended",
                thread: {
                  threadId: callerId,
                  providerSessionId: "provider:scheduled-ended",
                  providerInstanceId: shell.providerInstanceId,
                },
                client: undefined,
              },
              { projectId },
            ),
          ),
          Effect.provide(
            layerOrchestratorService.pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  Layer.mock(ThreadManagementService.ThreadManagementService)({
                    getThreadShell: () => Effect.succeed(null),
                    // Its turn ended: no run is active.
                    getThreadRecords: () => Effect.succeed(idleThreadProjection(shell)),
                  }),
                  ServerSettings.layerTest(),
                  mockProviderRegistry({
                    getProviders: Effect.succeed([]),
                  }),
                  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
                    list: () => Effect.succeed([]),
                  }),
                  Layer.mock(ProjectService.ProjectService)({}),
                  Layer.mock(SecretRequests.SecretRequests)({}),
                  Layer.mock(ScheduledTaskService.ScheduledTaskService)({
                    list: () => Effect.succeed({ tasks: [task({})] }),
                  }),
                ),
              ),
            ),
          ),
        );
        assert.equal(listed.tasks[0]?.webhookUrl, undefined);
      }),
    );

    it.effect("schedules with the environment's default model when the project inherits it", () =>
      Effect.gen(function* () {
        const environmentDefault = {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-5-5",
        };
        const models: Array<unknown> = [];
        yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) =>
            mcp.scheduleTask(supervisedClient, {
              projectId,
              prompt: "Check the build",
              schedule: { type: "interval", everyMs: 3_600_000 },
            }),
          ),
          Effect.provide(
            layerOrchestratorService.pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  Layer.mock(ThreadManagementService.ThreadManagementService)({
                    getThreadShell: () => Effect.succeed(null),
                  }),
                  ServerSettings.layerTest({ defaultModelSelection: environmentDefault }),
                  mockProviderRegistry({
                    getProviders: Effect.succeed([]),
                  }),
                  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
                    list: () => Effect.succeed([]),
                  }),
                  Layer.mock(ProjectService.ProjectService)({
                    getById: () =>
                      Effect.succeedSome({
                        id: projectId,
                        workspaceRoot: "/work/scheduled",
                        defaultModelSelection: null,
                      } as never),
                  }),
                  Layer.mock(SecretRequests.SecretRequests)({}),
                  Layer.mock(ScheduledTaskService.ScheduledTaskService)({
                    upsert: (input) =>
                      Effect.sync(() => {
                        models.push(input.modelSelection);
                        return { task: task({}) };
                      }),
                  }),
                ),
              ),
            ),
          ),
        );
        assert.deepEqual(models, [environmentDefault]);
      }),
    );

    it.effect("never shows a read-only client a webhook URL", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const listed = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) =>
            mcp.listScheduledTasks(
              {
                ...supervisedClient,
                client: { sessionId: "scheduled", label: "Claude Code", access: "read-only" },
              },
              { projectId },
            ),
          ),
          Effect.provide(service([task({})], null, upserted)),
        );
        assert.equal(listed.tasks[0]?.webhookUrl, undefined);
      }),
    );

    it.effect("checks a bound task against its thread's current modes", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        // Scheduled while the thread was Supervised; the thread now runs in full access.
        const bound = task({ threadId: boundThreadId });
        const layer = service(
          [bound],
          liveThreadShell(boundThreadId, { runtimeMode: "full-access" }),
          upserted,
        );
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(layer),
        );
        const listed = yield* mcp.listScheduledTasks(supervisedClient, { projectId });
        assert.equal(listed.tasks[0]?.webhookUrl, undefined);
        const error = yield* mcp
          .updateScheduledTask(supervisedClient, {
            scheduledTaskId: bound.id,
            prompt: "Something else",
          })
          .pipe(Effect.flip);
        assert.equal(error.code, "runtime_mode_escalation_denied");
        assert.equal(yield* Ref.get(upserted), 0);
      }),
    );

    it.effect("reports a saved task even when its bound thread cannot be read", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const bound = task({ threadId: boundThreadId });
        const lookups = yield* Ref.make(0);
        // The edit's own check reads the thread; the read after the save fails.
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(
            layerOrchestratorService.pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  Layer.mock(ThreadManagementService.ThreadManagementService)({
                    getThreadShell: (threadId) =>
                      Ref.getAndUpdate(lookups, (count) => count + 1).pipe(
                        Effect.flatMap((count) =>
                          count === 0
                            ? Effect.succeed(
                                liveThreadShell(threadId, { runtimeMode: "approval-required" }),
                              )
                            : Effect.fail(new OrchestratorProjectionError({ threadId })),
                        ),
                      ),
                  }),
                  ServerSettings.layerTest(),
                  mockProviderRegistry({
                    getProviders: Effect.succeed([]),
                  }),
                  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
                    list: () => Effect.succeed([]),
                  }),
                  Layer.mock(ProjectService.ProjectService)({}),
                  Layer.mock(SecretRequests.SecretRequests)({}),
                  Layer.mock(ScheduledTaskService.ScheduledTaskService)({
                    list: () => Effect.succeed({ tasks: [bound] }),
                    upsert: () =>
                      Ref.update(upserted, (count) => count + 1).pipe(Effect.as({ task: bound })),
                  }),
                ),
              ),
            ),
          ),
        );
        const updated = yield* mcp.updateScheduledTask(supervisedClient, {
          scheduledTaskId: bound.id,
          prompt: "Something else",
        });
        assert.equal(yield* Ref.get(upserted), 1);
        assert.equal(updated.scheduledTaskId, bound.id);
        assert.equal(updated.webhookUrl, undefined);
      }),
    );
  });

  describe("resolveRuntimeMode", () => {
    // Muse offers only these two, and runs any other mode as Supervised.
    const muse = {
      modelSelection: { instanceId: ProviderInstanceId.make("muse"), model: "muse-model" },
      supportedRuntimeModes: ["approval-required", "full-access"] as const,
    };

    it.effect("refuses an explicit mode the target provider does not offer", () =>
      Effect.gen(function* () {
        const error = yield* DelegationModes.resolveRuntimeMode(
          "full-access",
          "auto-accept-edits",
          muse,
        ).pipe(Effect.flip);
        assert.equal(error.code, "invalid_request");
        assert.include(error.message, "approval-required, full-access");
      }),
    );

    it.effect("steps an inherited mode down to the broadest one the provider offers", () =>
      Effect.gen(function* () {
        assert.equal(
          yield* DelegationModes.resolveRuntimeMode("full-access", "inherit", muse),
          "full-access",
        );
        assert.equal(
          yield* DelegationModes.resolveRuntimeMode("auto", undefined, muse),
          "approval-required",
        );
      }),
    );
  });
});

it.effect("reports held sends and cancels only the owning parent's queued message", () =>
  Effect.gen(function* () {
    const parentId = ThreadId.make("held-owner");
    const childId = ThreadId.make("held-child");
    const command = "command:mcp:owner:thread-send:followup";
    const taskId = NodeId.make(`node:delegated-task:${encodeURIComponent(command)}`);
    const childShell = liveThreadShell(childId);
    const now = DateTime.makeUnsafe("2026-10-27T19:50:12.004Z");
    const queued = {
      id: RunId.make("held-send"),
      threadId: childId,
      ordinal: 2,
      status: "queued" as const,
      queueHeld: true,
      userMessageId: MessageId.make("message:mcp:owner:thread-send:followup"),
      delegatedTaskId: taskId,
      requestedAt: now,
      startedAt: null,
      completedAt: null,
      restartCancelledBackgroundWork: undefined,
    } as OrchestrationV2ThreadProjection["runs"][number];
    const child = {
      ...idleThreadProjection(childShell),
      thread: {
        ...idleThreadProjection(childShell).thread,
        lineage: {
          rootThreadId: parentId,
          parentThreadId: parentId,
          relationshipToParent: "subagent" as const,
        },
      },
      runs: [
        queued,
        {
          ...queued,
          id: RunId.make("other-sender"),
          ordinal: 3,
          delegatedTaskId: NodeId.make("other-task"),
          userMessageId: MessageId.make("message:mcp:other:thread-send:followup"),
        },
      ],
    };
    const parent = {
      ...idleThreadProjection(liveThreadShell(parentId)),
      subagents: [
        {
          id: taskId,
          threadId: parentId,
          origin: "app_owned",
          childThreadId: childId,
          driver: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          model: null,
          result: null,
          prompt: "followup",
          status: "running",
          startedAt: now,
          completedAt: null,
          completionDelivery: { state: "pending" },
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const stranger = idleThreadProjection(liveThreadShell(ThreadId.make("stranger")));
    const childState = yield* Ref.make<OrchestrationV2ThreadProjection>(child);
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
    const dependencies = Layer.mergeAll(
      NodeServices.layer,
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: (id) =>
          id === childId
            ? Ref.get(childState)
            : Effect.succeed(id === parentId ? parent : stranger),
        recoverDelegatedTask: () => Effect.void,
        delegatedTaskResultPending: () => Effect.succeed(false),
        getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
        dispatch: (command) =>
          Effect.gen(function* () {
            yield* Ref.update(commands, (all) => [...all, command]);
            if (command.type === "queued-run.cancel") {
              yield* Ref.update(childState, (projection) => ({
                ...projection,
                runs: projection.runs.map((run) =>
                  run.id === command.runId ? { ...run, status: "cancelled" as const } : run,
                ),
              }));
            }
            return {} as never;
          }),
      }),
      ServerSettings.layerTest(),
      mockProviderRegistry({ getProviders: Effect.succeed([]) }),
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
        list: () => Effect.succeed([]),
      }),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    );
    const scope: McpInvocationScope = {
      environmentId: EnvironmentId.make("held-env"),
      requestNamespace: "owner-session",
      thread: {
        threadId: parentId,
        providerSessionId: "owner-session",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
    };
    yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      assert.equal((yield* service.taskStatus(scope, taskId)).status, "held");
      const denied = yield* service
        .cancelTask(
          { ...scope, thread: { ...scope.thread!, threadId: stranger.thread.id } },
          { taskId },
        )
        .pipe(Effect.flip);
      assert.equal(denied.code, "task_not_found");
      assert.deepEqual(yield* Ref.get(commands), []);
      assert.equal(
        (yield* service.cancelTask(scope, { taskId, clientRequestId: "cancel-held" })).status,
        "cancelled",
      );
      yield* service.cancelTask(scope, { taskId, clientRequestId: "cancel-held" });
      const dispatched = yield* Ref.get(commands);
      const cancelled = dispatched.filter((command) => command.type === "queued-run.cancel");
      assert.equal(cancelled.length, 1);
      assert.equal(cancelled[0]?.runId, queued.id);
      assert.equal(cancelled[0]?.threadId, childId);
      assert.isFalse(dispatched.some((command) => command.type === "thread.stop"));
    }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
  }),
);

it.effect(
  "delegate_task inherits the latest workflow context by turn-item order when message timestamps tie",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:workflow-order");
      const threadId = ThreadId.make("thread:workflow-order");
      const runId = RunId.make("run:workflow-order:1");
      const rootNodeId = NodeId.make("node:workflow-order:root");
      const originalMessageId = MessageId.make("z-original-review");
      const steerMessageId = MessageId.make("a-steer-review");
      const modelSelection: ModelSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      };
      const originalContext = {
        version: 1 as const,
        records: [
          {
            version: 1 as const,
            contextId: ComposerContextId.make("ctx_wf_original"),
            label: "original-review",
            kind: "workflow" as const,
            workflowId: WorkflowId.make("wf_def_original"),
            runId: WorkflowRunId.make("wf_original"),
          },
        ],
      };
      const steerContext = {
        version: 1 as const,
        records: [
          {
            version: 1 as const,
            contextId: ComposerContextId.make("ctx_wf_steer"),
            label: "steer-review",
            kind: "workflow" as const,
            workflowId: WorkflowId.make("wf_def_steer"),
            runId: WorkflowRunId.make("wf_steer"),
          },
        ],
      };

      yield* store.apply({
        id: EventId.make("event:wf-order:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          id: threadId,
          projectId,
          title: "Workflow order",
          branch: null,
          worktreePath: null,
          providerInstanceId: modelSelection.instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: threadId,
          },
          forkedFrom: null,
          createdBy: "user",
          creationSource: "web",
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* store.apply({
        id: EventId.make("event:wf-order:run"),
        type: "run.created",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          userMessageId: originalMessageId,
          rootNodeId,
          activeAttemptId: null,
          providerThreadId: null,
          providerInstanceId: modelSelection.instanceId,
          modelSelection,
          status: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          queuePosition: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      // Both user messages share the exact same createdAt; SQLite's (created_at, message_id)
      // order puts a-steer-review BEFORE z-original-review, while turn-item ordinal puts
      // z-original-review (ordinal 1) BEFORE a-steer-review (ordinal 2).
      yield* store.apply({
        id: EventId.make("event:wf-order:msg-original"),
        type: "message.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        occurredAt: now,
        payload: {
          id: originalMessageId,
          threadId,
          runId,
          nodeId: rootNodeId,
          role: "user",
          text: "Original prompt",
          attachments: [],
          context: originalContext,
          createdBy: "user",
          creationSource: "web",
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* store.apply({
        id: EventId.make("event:wf-order:msg-steer"),
        type: "message.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        occurredAt: now,
        payload: {
          id: steerMessageId,
          threadId,
          runId,
          nodeId: rootNodeId,
          role: "user",
          text: "Steer prompt",
          attachments: [],
          context: steerContext,
          createdBy: "user",
          creationSource: "web",
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* store.apply({
        id: EventId.make("event:wf-order:item-original"),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("turn-item:wf-order:1"),
          threadId,
          runId,
          nodeId: rootNodeId,
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
          type: "user_message",
          messageId: originalMessageId,
          inputIntent: "turn_start",
          text: "Original prompt",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      yield* store.apply({
        id: EventId.make("event:wf-order:item-steer"),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("turn-item:wf-order:2"),
          threadId,
          runId,
          nodeId: rootNodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 2,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message",
          messageId: steerMessageId,
          inputIntent: "steer",
          text: "Steer prompt",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });

      const observedContexts = yield* Ref.make<Array<unknown>>([]);
      const workflowsLayer = Layer.mock(WorkflowsService.WorkflowsService)({
        delegate: (_parentThreadId, _commandId, _input, _inherited, _create, context) =>
          Ref.update(observedContexts, (all) => [...all, context]).pipe(
            Effect.as({
              taskId: NodeId.make("task:wf-order:1"),
              childThreadId: ThreadId.make("thread:wf-order:child"),
              status: "running",
            } as never),
          ),
      });
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (id, fields, filter) =>
            store.getThreadRecords(id, fields, filter) as never,
          getThreadShell: (id) => store.getThreadShell(id) as never,
        }),
        ServerSettings.layerTest(),
        mockProviderRegistry({
          getProviders: Effect.succeed([
            {
              instanceId: modelSelection.instanceId,
              driver: ProviderDriverKind.make("codex"),
              label: "Codex",
              enabled: true,
              status: "ready",
              models: [
                {
                  slug: modelSelection.model,
                  name: modelSelection.model,
                  supportsReasoning: true,
                  supportsImages: true,
                  options: [],
                },
              ],
            } as unknown as ServerProvider,
          ]),
        }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        workflowsLayer,
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("wf-order-env"),
        requestNamespace: "wf-order-session",
        thread: {
          threadId,
          providerSessionId: "wf-order-session",
          providerInstanceId: modelSelection.instanceId,
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        yield* service.delegateTask(scope, {
          task: "Review changes",
          clientRequestId: "wf-order-delegate-1",
        });
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));

      const seen = yield* Ref.get(observedContexts);
      assert.deepEqual(seen, [steerContext]);
    }).pipe(
      Effect.provide(ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    ),
);
