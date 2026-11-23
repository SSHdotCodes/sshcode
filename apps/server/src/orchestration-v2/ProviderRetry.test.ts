import { interruptThreadTurn } from "../../../../packages/client-runtime/src/operations/commands.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../../../../packages/client-runtime/src/connection/model.ts";
import * as EnvironmentSupervisor from "../../../../packages/client-runtime/src/connection/supervisor.ts";
import type { RpcSession } from "../../../../packages/client-runtime/src/rpc/session.ts";
import type { WsRpcProtocolClient } from "../../../../packages/client-runtime/src/rpc/protocol.ts";
import * as Crypto from "effect/Crypto";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as EffectWorker from "./EffectWorker.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  EventId,
  MessageId,
  NodeId,
  RunId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderFailure,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { nextAutomaticProviderRetry } from "./ProviderRetry.ts";
import { providerRetryCommand, sweep } from "./ProviderRetryWorker.ts";
import { automaticProviderRetryPresentation } from "@t3tools/shared/orchestrationV2ThreadError";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-6.1" };
const failure: OrchestrationV2ProviderFailure = {
  class: "provider_error",
  code: "serverOverloaded",
  retryable: true,
  message: "Selected model is at capacity. Please try a different model",
};
const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Retry scheduling must not call a real provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const layerTest = ThreadManagement.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      database,
      ProjectionStore.layer.pipe(Layer.provide(database)),
      EffectOutbox.layer.pipe(Layer.provide(database)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "automatic-provider-retry" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: database, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(database))),
);

const send = (threadId: ThreadId, text: string, queued = false) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type: queued ? "queue_after_active" : "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  });

const seedFailedRun = (key: string, queue = false) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make(`thread:${key}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${key}`),
      threadId,
      projectId: ProjectId.make("project:automatic-provider-retry"),
      title: key,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* send(threadId, "Do the work.");
    if (queue) yield* send(threadId, "Keep this queued steer.", true);
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const run = projection.runs[0]!;
    const automaticProviderRetry = nextAutomaticProviderRetry(failure, undefined, now)!;
    const source = {
      ...run,
      status: "failed" as const,
      startedAt: now,
      completedAt: now,
      automaticProviderRetry,
    };
    const thread = projection.providerThreads.find((thread) => thread.id === run.providerThreadId)!;
    const eventBase = { threadId, runId: run.id, occurredAt: now };
    const error = {
      id: TurnItemId.make(`error:${key}`),
      threadId,
      runId: run.id,
      nodeId: run.rootNodeId,
      providerThreadId: run.providerThreadId,
      providerTurnId: ProviderTurnId.make(`turn:${key}`),
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 3,
      status: "failed" as const,
      title: "Provider error",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "error" as const,
      failure,
      automaticProviderRetry,
    };
    const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
      { ...eventBase, id: EventId.make(`failed:${key}`), type: "run.updated", payload: source },
      {
        ...eventBase,
        id: EventId.make(`thread-ready:${key}`),
        type: "provider-thread.updated",
        payload: {
          ...thread,
          status: "idle",
          nativeThreadRef: { driver, nativeId: `native:${key}`, strength: "strong" },
        },
      },
      { ...eventBase, id: EventId.make(`error:${key}`), type: "turn-item.updated", payload: error },
      {
        ...eventBase,
        id: EventId.make(`tool:${key}`),
        type: "turn-item.updated",
        payload: {
          ...error,
          id: TurnItemId.make(`tool:${key}`),
          type: "command_execution",
          ordinal: 2,
          status: "completed",
          input: "already completed side effect",
          output: "done",
          exitCode: 0,
        },
      },
    ];
    yield* sink.write({ events });
    return { source, threadId, error };
  });

const layerClientStopCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

const connectedStopClient = Effect.fn("ProviderRetryTest.connectedStopClient")(function* (
  snapshot: OrchestrationV2ThreadProjection,
  admitBeforeDispatch = false,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const commands: Array<OrchestrationV2Command> = [];
  const projectionRequests: Array<ThreadId> = [];
  const admit = admitBeforeDispatch
    ? sweep().pipe(
        Effect.provideService(ThreadManagement.ThreadManagementService, threads),
        Effect.provideService(ProjectionStore.ProjectionStoreV2, projections),
      )
    : Effect.void;
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: ({
      threadId,
    }: {
      readonly threadId: ThreadId;
    }) =>
      Effect.sync(() => {
        projectionRequests.push(threadId);
        return snapshot;
      }),
    [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
      Effect.gen(function* () {
        commands.push(command);
        // The scheduler wins the server thread lock after the client rendered
        // the source's Stop button, before the actual Stop RPC is admitted.
        yield* admit;
        return yield* threads.dispatch(command);
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.die("Stop does not need server config"),
    subscribeServerConfig: () => {
      throw new Error("unused config subscription");
    },
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make("retry-stop-client"),
      label: "Retry Stop test",
      httpBaseUrl: "https://retry.example.test",
      wsBaseUrl: "wss://retry.example.test",
    }),
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  return { supervisor, commands, projectionRequests };
});

it.effect.each([
  { client: "web", admitBeforeDispatch: false },
  { client: "web", admitBeforeDispatch: true },
  { client: "mobile", admitBeforeDispatch: false },
  { client: "mobile", admitBeforeDispatch: true },
] as const)(
  "the real shared client Stop cancels the retry across admission (%j)",
  ({ client, admitBeforeDispatch }) =>
    Effect.gen(function* () {
      const { source, threadId } = yield* seedFailedRun(
        `client-entry:${client}:${admitBeforeDispatch}`,
        true,
      );
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const snapshot = yield* orchestrator.getThreadProjection(threadId);
      if (admitBeforeDispatch) yield* TestClock.adjust("5 seconds");
      const connected = yield* connectedStopClient(snapshot, admitBeforeDispatch);
      // These are the exact call shapes used by ChatView and ThreadRouteScreen.
      yield* interruptThreadTurn({
        commandId: CommandId.make("shared-client:stop"),
        threadId,
        ...(client === "mobile" ? { runId: source.id } : {}),
      }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, connected.supervisor),
        Effect.provide(layerClientStopCrypto),
      );
      assert.equal(connected.commands.length, 1);
      assert.equal(connected.commands[0]?.type, "run.interrupt");
      assert.equal(connected.projectionRequests.length, client === "web" ? 1 : 0);
      const stopped = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(stopped.runs[1]?.queueHeld, true);
      assert.isFalse(
        stopped.runs.some(
          (run) =>
            run.status === "starting" ||
            run.status === "running" ||
            run.automaticProviderRetry?.status === "scheduled",
        ),
      );
      if (admitBeforeDispatch) assert.equal(stopped.runs[2]?.status, "interrupted");
      else assert.equal(stopped.runs[0]?.automaticProviderRetry?.status, "cancelled");
      yield* TestClock.adjust("5 minutes");
      yield* sweep();
      assert.lengthOf(
        (yield* orchestrator.getThreadProjection(threadId)).runs,
        admitBeforeDispatch ? 3 : 2,
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "a stale client Stop for a finished retry cannot interrupt unrelated later user work",
  () =>
    Effect.gen(function* () {
      const { source, threadId } = yield* seedFailedRun("stale-stop-unrelated");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const snapshot = yield* orchestrator.getThreadProjection(threadId);
      yield* TestClock.adjust("5 seconds");
      yield* sweep();
      const continued = (yield* orchestrator.getThreadProjection(threadId)).runs[1]!;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("stale-stop:retry-completed"),
            type: "run.updated",
            threadId,
            runId: continued.id,
            occurredAt: now,
            payload: { ...continued, status: "completed", startedAt: now, completedAt: now },
          },
        ],
      });
      yield* send(threadId, "Start separate new work.");
      const connected = yield* connectedStopClient(snapshot);
      const stopped = yield* interruptThreadTurn({
        commandId: CommandId.make("stale-client:stop"),
        threadId,
        runId: source.id,
      }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, connected.supervisor),
        Effect.provide(layerClientStopCrypto),
        Effect.exit,
      );
      assert.equal(stopped._tag, "Failure");
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(after.runs, 3);
      assert.equal(after.runs[2]?.status, "starting");
      assert.equal(after.runs[1]?.status, "completed");
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "recovers a persisted due retry using the same native conversation and exact model, once",
  () =>
    Effect.gen(function* () {
      const { source, threadId, error } = yield* seedFailedRun("restart", true);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* sweep();
      assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 2);
      assert.lengthOf(yield* projections.getProviderRetryCandidates(yield* DateTime.now), 0);
      yield* TestClock.adjust("5 seconds");
      // Reconstruct the projection service as a restarted worker does. No timer
      // or client state is needed to rediscover the committed due time.
      yield* orchestrator.dispatch(providerRetryCommand(source));
      yield* sweep().pipe(Effect.provide(ProjectionStore.layer));
      yield* sweep();
      yield* orchestrator.dispatch(providerRetryCommand(source));
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(after.runs, 3);
      const retry = after.runs[2]!;
      assert.deepEqual(retry.modelSelection, modelSelection);
      assert.equal(retry.providerThreadId, source.providerThreadId);
      assert.equal(
        after.providerThreads.find((thread) => thread.id === retry.providerThreadId)
          ?.nativeThreadRef?.nativeId,
        "native:restart",
      );
      assert.equal(retry.providerRetryContinuationOfRunId, source.id);
      assert.equal(retry.automaticProviderRetry?.attempt, 1);
      assert.equal(after.runs[1]?.status, "queued");
      assert.equal(after.messages.filter((message) => message.createdBy === "user").length, 2);
      assert.equal(after.messages.at(-1)?.createdBy, "agent");
      assert.include(after.messages.at(-1)?.text ?? "", "resume unfinished work");
      assert.equal(after.turnItems.filter((item) => item.type === "command_execution").length, 1);
      const retryItem = after.turnItems.find((item) => item.id === error.id);
      assert.equal(
        retryItem?.type === "error" ? retryItem.automaticProviderRetry?.status : null,
        "started",
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("re-sends a steer the failed turn may not have read with the retry", () =>
  Effect.gen(function* () {
    const { source, threadId } = yield* seedFailedRun("unread-steer");
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const seeded = yield* orchestrator.getThreadProjection(threadId);
    const prompt = seeded.messages[0]!;
    const promptItem = seeded.turnItems.find((item) => item.type === "user_message")!;
    const steerId = MessageId.make(`message:${threadId}:steer`);
    // The steer arrived after the last output, then the provider turn failed.
    yield* sink.write({
      events: [
        {
          id: EventId.make("unread-steer:message"),
          type: "message.updated",
          threadId,
          runId: source.id,
          occurredAt: now,
          payload: { ...prompt, id: steerId, text: "use the staging database", runId: source.id },
        },
        {
          id: EventId.make("unread-steer:item"),
          type: "turn-item.updated",
          threadId,
          runId: source.id,
          occurredAt: now,
          payload: {
            ...promptItem,
            id: TurnItemId.make("turn-item:unread-steer"),
            runId: source.id,
            ordinal: 4,
            ...(promptItem.type === "user_message"
              ? {
                  messageId: steerId,
                  inputIntent: "steer" as const,
                  text: "use the staging database",
                }
              : {}),
          },
        },
      ],
    });
    yield* TestClock.adjust("5 seconds");
    yield* sweep();
    const retry = (yield* orchestrator.getThreadProjection(threadId)).messages.at(-1);
    assert.equal(retry?.createdBy, "agent");
    assert.include(retry?.text ?? "", "use the staging database");
    assert.include(retry?.text ?? "", "resume unfinished work");
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["stop", "manual", "model-change", "archive", "settle", "snooze"] as const)(
  "a stale retry cannot race %s or consume queued steering",
  (action) =>
    Effect.gen(function* () {
      const hasQueuedSteer = action === "stop" || action === "manual" || action === "model-change";
      const { source, threadId } = yield* seedFailedRun(action, hasQueuedSteer);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      if (action === "stop")
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`stop:${action}`),
          threadId,
        });
      else if (action === "manual") yield* send(threadId, "Continue with my new instruction.");
      else if (action === "archive")
        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make(`archive:${action}`),
          threadId,
        });
      else if (action === "settle")
        yield* orchestrator.dispatch({
          type: "thread.settle",
          commandId: CommandId.make(`settle:${action}`),
          threadId,
        });
      else if (action === "snooze")
        yield* orchestrator.dispatch({
          type: "thread.snooze",
          commandId: CommandId.make(`snooze:${action}`),
          threadId,
          snoozedUntil: DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 1 })),
        });
      else
        yield* orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make(`model:${action}`),
          threadId,
          modelSelection: { ...modelSelection, model: "another-current-model" },
        });
      const before = yield* orchestrator.getThreadProjection(threadId);
      yield* TestClock.adjust("5 seconds");
      yield* orchestrator.dispatch(providerRetryCommand(source));
      yield* sweep();
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(after.runs, before.runs.length);
      if (hasQueuedSteer) {
        assert.equal(after.runs[1]?.status, "queued");
        assert.equal(
          after.messages.filter((message) => message.text === "Keep this queued steer.").length,
          1,
        );
      }
      assert.equal(after.runs[0]?.automaticProviderRetry?.status, "cancelled");
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { holdQueue: true, missingBindings: false },
  { holdQueue: true, missingBindings: true },
  { holdQueue: false, missingBindings: false },
  { holdQueue: false, missingBindings: true },
])(
  "the client run.interrupt command cancels a pending retry (%j)",
  ({ holdQueue, missingBindings }) =>
    Effect.gen(function* () {
      const { threadId, source } = yield* seedFailedRun(
        `client-stop:${holdQueue}:${missingBindings}`,
        true,
      );
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      yield* sink.write({
        events: [
          {
            id: EventId.make("client-stop:pending-cohort"),
            type: "run.updated",
            threadId,
            runId: source.id,
            occurredAt: yield* DateTime.now,
            payload: {
              ...source,
              ...(missingBindings ? { rootNodeId: null, providerThreadId: null } : {}),
              delegatedCompletion: { disposition: "open", nextGeneration: 1, delivery: null },
            },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("client-stop:interrupt"),
        threadId,
        runId: source.id,
        holdQueue,
      });
      const stopped = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(stopped.runs[0]?.automaticProviderRetry?.status, "cancelled");
      assert.equal(stopped.runs[0]?.delegatedCompletion?.disposition, "stopped");
      if (holdQueue) assert.equal(stopped.runs[1]?.queueHeld, true);
      const error = stopped.turnItems.find((item) => item.type === "error");
      assert.equal(
        error?.type === "error" ? error.automaticProviderRetry?.status : null,
        "cancelled",
      );
      yield* TestClock.adjust("5 minutes");
      yield* sweep();
      assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 2);
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["archive", "settle", "snooze", "model"] as const)(
  "the real sweep cannot resurrect a retry after reversing %s",
  (action) =>
    Effect.gen(function* () {
      const { threadId } = yield* seedFailedRun(`reverse:${action}`);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const command = (step: string) => CommandId.make(`reverse:${action}:${step}`);
      if (action === "archive") {
        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: command("hide"),
          threadId,
        });
        yield* orchestrator.dispatch({
          type: "thread.unarchive",
          commandId: command("show"),
          threadId,
        });
      } else if (action === "settle") {
        yield* orchestrator.dispatch({
          type: "thread.settle",
          commandId: command("hide"),
          threadId,
        });
        yield* orchestrator.dispatch({
          type: "thread.unsettle",
          commandId: command("show"),
          threadId,
          reason: "user",
        });
      } else if (action === "snooze") {
        yield* orchestrator.dispatch({
          type: "thread.snooze",
          commandId: command("hide"),
          threadId,
          snoozedUntil: DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 1 })),
        });
        yield* orchestrator.dispatch({
          type: "thread.unsnooze",
          commandId: command("show"),
          threadId,
          reason: "user",
        });
      } else {
        yield* orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: command("other"),
          threadId,
          modelSelection: { ...modelSelection, model: "another-current-model" },
        });
        yield* orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: command("original"),
          threadId,
          modelSelection,
        });
      }
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.automaticProviderRetry?.status,
        "cancelled",
      );
      yield* TestClock.adjust("10 minutes");
      yield* sweep();
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(after.runs, 1);
      assert.lengthOf(after.messages, 1);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("cancels a due retry when its selected provider is disabled", () =>
  Effect.gen(function* () {
    const { threadId } = yield* seedFailedRun("disabled");
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({
      projectSettingsOverrides: {
        [ProjectId.make("project:automatic-provider-retry")]: {
          providerInstances: { [instanceId]: { enabled: false } },
        },
      },
    });
    yield* TestClock.adjust("5 seconds");
    yield* sweep();
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const after = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(after.runs[0]?.automaticProviderRetry?.status, "cancelled");
    assert.lengthOf(after.runs, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([false, true])(
  "recovers a committed retry lost before provider start (stop=%s)",
  (stop) =>
    Effect.gen(function* () {
      const { threadId, source } = yield* seedFailedRun(`admission-gap:${stop}`);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* TestClock.adjust("5 seconds");
      yield* orchestrator.dispatch(providerRetryCommand(source));
      const admitted = (yield* orchestrator.getThreadProjection(threadId)).runs[1]!;
      assert.equal(admitted.status, "starting");
      assert.isNull(admitted.startedAt);
      const recovery = yield* ProviderRuntimeRecovery.make.pipe(Effect.provide(IdAllocator.layer));
      yield* recovery.reconcile("startup");
      const recovered = (yield* orchestrator.getThreadProjection(threadId)).runs[1]!;
      assert.equal(recovered.status, "cancelled");
      assert.equal(recovered.automaticProviderRetry?.status, "scheduled");
      assert.equal(recovered.automaticProviderRetry?.attempt, 1);
      if (stop)
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`stop-gap:${stop}`),
          threadId,
        });
      yield* sweep();
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(after.runs, stop ? 2 : 3);
      if (!stop) {
        assert.equal(after.runs[2]?.status, "starting");
        assert.equal(after.runs[2]?.automaticProviderRetry?.attempt, 1);
        assert.equal(after.runs[2]?.providerThreadId, source.providerThreadId);
      }
      assert.equal(after.messages.filter((message) => message.createdBy === "user").length, 1);
      assert.equal(after.turnItems.filter((item) => item.type === "command_execution").length, 1);
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { requested: false, nativeTurn: false, rearm: true },
  { requested: true, nativeTurn: false, rearm: false },
  { requested: undefined, nativeTurn: false, rearm: false },
  { requested: false, nativeTurn: true, rearm: false },
])("reconciles running retry admission conservatively (%j)", ({ requested, nativeTurn, rearm }) =>
  Effect.gen(function* () {
    const { threadId, source } = yield* seedFailedRun(
      `running-admission:${requested}:${nativeTurn}`,
    );
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    yield* TestClock.adjust("5 seconds");
    yield* orchestrator.dispatch(providerRetryCommand(source));
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const admitted = projection.runs[1]!;
    const attempt = projection.attempts.find((attempt) => attempt.id === admitted.activeAttemptId)!;
    const now = yield* DateTime.now;
    // This is the app-side running transaction, before RunExecutionService
    // requests native admission. Missing legacy markers remain uncertain.
    yield* sink.write({
      events: [
        {
          id: EventId.make("running-admission:run"),
          type: "run.updated",
          threadId,
          runId: admitted.id,
          occurredAt: now,
          payload: { ...admitted, status: "running", startedAt: now },
        },
        {
          id: EventId.make("running-admission:attempt"),
          type: "run-attempt.updated",
          threadId,
          runId: admitted.id,
          occurredAt: now,
          payload: {
            ...attempt,
            status: "running",
            startedAt: now,
            ...(requested === undefined ? {} : { providerStartRequested: requested }),
          },
        },
        ...(nativeTurn
          ? [
              {
                id: EventId.make("running-admission:accepted"),
                type: "provider-turn.updated" as const,
                threadId,
                runId: admitted.id,
                occurredAt: now,
                payload: {
                  id: ProviderTurnId.make("running-admission:accepted"),
                  providerThreadId: attempt.providerThreadId,
                  nodeId: attempt.rootNodeId,
                  runAttemptId: attempt.id,
                  ordinal: 1,
                  status: "running" as const,
                  nativeTurnRef: {
                    driver,
                    nativeId: "accepted-before-crash",
                    strength: "strong" as const,
                  },
                  startedAt: now,
                  completedAt: null,
                },
              },
            ]
          : []),
      ],
    });
    assert.lengthOf(
      (yield* orchestrator.getThreadProjection(threadId)).providerTurns,
      nativeTurn ? 1 : 0,
    );
    const recovery = yield* ProviderRuntimeRecovery.make.pipe(Effect.provide(IdAllocator.layer));
    yield* recovery.reconcile("startup");
    yield* sweep();
    const after = yield* orchestrator.getThreadProjection(threadId);
    assert.lengthOf(after.runs, rearm ? 3 : 2);
    assert.equal(after.runs[1]?.automaticProviderRetry?.status, "started");
    if (rearm) {
      assert.equal(after.runs[2]?.automaticProviderRetry?.attempt, 1);
      assert.equal(after.runs[2]?.providerThreadId, source.providerThreadId);
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "retries a turn that a child result started like any other after a temporary failure",
  () =>
    Effect.gen(function* () {
      const { source, threadId } = yield* seedFailedRun("refused-result-wake");
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const message = (yield* store.getRunMessage(threadId, source.id))!;
      yield* store.apply({
        id: EventId.make("mark-wake"),
        type: "message.updated",
        threadId,
        runId: source.id,
        occurredAt: message.createdAt,
        payload: {
          ...message,
          createdBy: "agent",
          creationSource: "server",
          delegatedCompletion: {
            parentRunId: RunId.make("delegating-run"),
            generation: 1,
            taskIds: [NodeId.make("result-task")],
          },
        },
      });
      yield* TestClock.adjust("5 seconds");
      yield* sweep();
      const { runs } = yield* store.getThreadRecords(threadId, ["runs"]);
      assert.lengthOf(runs, 2);
      assert.equal(
        runs.find((run) => run.id === source.id)?.automaticProviderRetry?.status,
        "started",
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("bounds automatic backoff and leaves an actionable exhausted error", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    let retry = nextAutomaticProviderRetry(failure, undefined, now)!;
    for (const [index, delay] of [5_000, 15_000, 30_000, 60_000, 120_000].entries()) {
      assert.equal(retry.attempt, index + 1);
      assert.equal(Date.parse(retry.scheduledAt!) - DateTime.toEpochMillis(now), delay);
      retry = nextAutomaticProviderRetry(
        failure,
        { ...retry, status: "started", scheduledAt: null },
        now,
      )!;
    }
    assert.equal(retry.status, "exhausted");
    assert.isNull(retry.scheduledAt);
    const { error } = yield* seedFailedRun("presentation");
    assert.include(
      automaticProviderRetryPresentation({ ...error, automaticProviderRetry: retry })!.detail,
      "retry manually",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { class: "usage_limit", code: "usageLimitExceeded", retryable: true },
  { class: "billing_error", code: "insufficient_quota", retryable: true },
  { class: "subscription_error", code: "-32000", retryable: true },
  { class: "authentication_error", code: "unauthorized", retryable: true },
  { class: "permission_error", code: "unauthorized", retryable: true },
  { class: "provider_error", code: "insufficient_quota", retryable: true },
  { class: "provider_error", code: "api_error_429", retryable: true, message: "HTTP 429" },
  { class: "provider_error", code: "provider.rate-limit", retryable: true, message: "HTTP 429" },
  { class: "provider_error", code: "serverError", retryable: null, message: "Internal error" },
  { class: "provider_error", code: "auth_refresh_failed", retryable: true },
  { class: "provider_error", code: "serverOverloaded", retryable: false },
  { class: "provider_error", code: "api_error_501", retryable: true },
  { class: "provider_error", code: "api_error_404", retryable: null, message: "Try again later." },
  { class: "validation_error", code: null, retryable: true },
] satisfies ReadonlyArray<Partial<OrchestrationV2ProviderFailure>>)(
  "excludes permanent/account failure %j",
  (patch) =>
    Effect.gen(function* () {
      assert.isUndefined(
        nextAutomaticProviderRetry({ ...failure, ...patch }, undefined, yield* DateTime.now),
      );
    }),
);

// Vertex's shared-capacity 429. It was retried from 2026-11-11; on 2026-11-16 five retries
// of it held a subagent for 15 minutes, each meeting the same limit.
const busy429 =
  'Provider request failed with HTTP 429: [{ "error": { "code": 429, "message": "Resource exhausted. Please try again later. Please refer to https://cloud.google.com/vertex-ai/generative-ai/docs/error-code-429 for more details.", "status": "RESOURCE_EXHAUSTED" } }]';

it.effect.each([
  { code: "serverOverloaded", retryable: null },
  { code: null, retryable: true, message: "The model is overloaded. Try again later." },
  { code: null, retryable: null, message: "The model is overloaded. Try again later." },
  { code: "api_error_503", retryable: null, message: "Service temporarily unavailable." },
] satisfies ReadonlyArray<Partial<OrchestrationV2ProviderFailure>>)(
  "retries an overloaded provider %j",
  (patch) =>
    Effect.gen(function* () {
      const retry = nextAutomaticProviderRetry(
        { ...failure, ...patch },
        undefined,
        yield* DateTime.now,
      );
      assert.equal(retry?.status, "scheduled");
      assert.equal(retry?.attempt, 1);
    }),
);

it.effect.each([
  { code: "provider.rate-limit", retryable: null, message: busy429 },
  { code: "api_error_429", retryable: null, message: busy429 },
  { code: "429", retryable: true, message: "The model is overloaded. Please try again later." },
  // The 429 may only be in the words, and a retry flag does not make a limit pass.
  { code: null, retryable: null, message: busy429 },
  { code: null, retryable: true, message: busy429 },
  { code: null, retryable: true, message: "Resource has been exhausted (e.g. check quota)." },
  { code: "provider.rate-limit", retryable: false, message: busy429 },
  { code: "insufficient_quota", retryable: null, message: busy429 },
  {
    code: "provider.rate-limit",
    retryable: null,
    message: "Rate limit reached for your plan. Try again later.",
  },
  { class: "usage_limit", code: "provider.rate-limit", retryable: null, message: busy429 },
] satisfies ReadonlyArray<Partial<OrchestrationV2ProviderFailure>>)(
  "never retries a limit, however it is worded or flagged %j",
  (patch) =>
    Effect.gen(function* () {
      assert.isUndefined(
        nextAutomaticProviderRetry({ ...failure, ...patch }, undefined, yield* DateTime.now),
      );
    }),
);

it.effect("resumes partial provider work without replaying its prompt or completed tools", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("automatic-provider-retry");
      const starts: Array<ProviderAdapter.ProviderAdapterV2TurnInput> = [];
      let assertAdmission = (
        _input: ProviderAdapter.ProviderAdapterV2TurnInput,
      ): Effect.Effect<void> => Effect.void;
      let ensuredThreads = 0;
      const resumed: Array<string> = [];
      const replayAdapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        ...adapter,
        openSession: (sessionInput) =>
          Effect.gen(function* () {
            const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
            const now = yield* DateTime.now;
            return {
              instanceId,
              driver,
              providerSessionId: sessionInput.providerSessionId,
              providerSession: {
                id: sessionInput.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd,
                model: modelSelection.model,
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ensureThread: (input) =>
                Effect.sync(() => {
                  ensuredThreads += 1;
                  return {
                    ...input.existingProviderThread!,
                    nativeThreadRef: {
                      driver,
                      nativeId: "existing-native-conversation",
                      strength: "strong" as const,
                    },
                  };
                }),
              resumeThread: ({ providerThread }) =>
                Effect.sync(() => {
                  resumed.push(providerThread.nativeThreadRef!.nativeId!);
                  return providerThread;
                }),
              startTurn: (input) =>
                Effect.gen(function* () {
                  starts.push(input);
                  yield* assertAdmission(input);
                  const now = yield* DateTime.now;
                  const providerTurnId = ProviderTurnId.make(`turn:${input.attemptId}`);
                  const first = starts.length === 1;
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: providerTurnId,
                      providerThreadId: input.providerThread.id,
                      nodeId: input.rootNodeId,
                      runAttemptId: input.attemptId,
                      nativeTurnRef: {
                        driver,
                        nativeId: `native:${providerTurnId}`,
                        strength: "strong",
                      },
                      ordinal: input.providerTurnOrdinal,
                      status: first ? "failed" : "completed",
                      startedAt: now,
                      completedAt: now,
                    },
                  });
                  if (first)
                    yield* Queue.offer(events, {
                      type: "turn_item.updated",
                      driver,
                      turnItem: {
                        id: TurnItemId.make("completed-side-effect"),
                        threadId: input.threadId,
                        runId: input.runId,
                        nodeId: input.rootNodeId,
                        providerThreadId: input.providerThread.id,
                        providerTurnId,
                        nativeItemRef: null,
                        parentItemId: null,
                        ordinal: 2,
                        type: "command_execution",
                        input: "completed-side-effect",
                        output: "done",
                        exitCode: 0,
                        status: "completed",
                        title: "Finished tool",
                        startedAt: now,
                        completedAt: now,
                        updatedAt: now,
                      },
                    });
                  yield* Queue.offer(
                    events,
                    first
                      ? {
                          type: "turn.terminal",
                          driver,
                          providerThreadId: input.providerThread.id,
                          providerTurnId,
                          runOrdinal: input.runOrdinal,
                          status: "failed",
                          failure,
                          failureItemOrdinal: 3,
                          threadDisposition: "reusable",
                        }
                      : {
                          type: "turn.terminal",
                          driver,
                          providerThreadId: input.providerThread.id,
                          providerTurnId,
                          runOrdinal: input.runOrdinal,
                          status: "completed",
                          failure: null,
                          threadDisposition: "reusable",
                        },
                  );
                }),
              steerTurn: () => Effect.void,
              interruptTurn: () => Effect.void,
              respondToRuntimeRequest: () => Effect.void,
              readThreadSnapshot: () => Effect.die("must not rebuild native context"),
              forkThread: () => Effect.die("must not fork native context"),
              rollbackThread: () => Effect.die("must not rewind native context"),
            };
          }),
      };
      const runtime = ProviderReplayHarness.layerWithRegistry(
        { name: "automatic-provider-retry-pipeline", runtimePolicyOverride: { cwd } },
        ProviderAdapterRegistry.layerFromAdapters([replayAdapter]),
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("thread:automatic-provider-retry-pipeline");
        assertAdmission = (input) =>
          orchestrator.getThreadProjection(threadId).pipe(
            Effect.orDie,
            Effect.tap((projection) =>
              Effect.sync(() => {
                const run = projection.runs.find((run) => run.id === input.runId)!;
                const attempt = projection.attempts.find(
                  (attempt) => attempt.id === input.attemptId,
                )!;
                assert.equal(
                  attempt.providerStartRequested,
                  run.providerRetryContinuationOfRunId === undefined ? undefined : true,
                );
              }),
            ),
            Effect.asVoid,
          );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create:retry-pipeline"),
          threadId,
          projectId: ProjectId.make("project:retry-pipeline"),
          title: "Resume work",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        const failed = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) => event.type === "run.updated" && event.payload.status === "failed",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* send(threadId, "Do the work.");
        yield* worker.drain();
        yield* Fiber.join(failed);
        const source = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        assert.equal(source.automaticProviderRetry?.status, "scheduled");
        yield* TestClock.adjust("5 seconds");
        const completed = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) => event.type === "run.updated" && event.payload.status === "completed",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* orchestrator.dispatch(providerRetryCommand(source));
        yield* worker.drain();
        yield* Fiber.join(completed);
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(starts, 2);
        assert.deepEqual(
          starts.map((input) => input.modelSelection),
          [modelSelection, modelSelection],
        );
        assert.equal(starts.filter((input) => input.message.text === "Do the work.").length, 1);
        assert.equal(ensuredThreads, 1);
        assert.deepEqual(
          starts.map((input) => input.providerThread.nativeThreadRef?.nativeId),
          ["existing-native-conversation", "existing-native-conversation"],
        );
        assert.isTrue(resumed.every((nativeId) => nativeId === "existing-native-conversation"));
        assert.equal(
          after.turnItems.filter((item) => item.id === "completed-side-effect").length,
          1,
        );
        assert.equal(after.runs[1]?.status, "completed");
        assert.equal(
          after.attempts.find((attempt) => attempt.runId === after.runs[1]?.id)
            ?.providerStartRequested,
          true,
        );
      }).pipe(Effect.provide(runtime));
    }),
  ),
);
