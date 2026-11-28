import * as Option from "effect/Option";
import { expandDebugCommand } from "@t3tools/shared/debugCommand";
import {
  expandAssistantCitationsForProvider,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

const citedInput = (threadId: ThreadId, excerpt = "That path needs a retry.") =>
  serializeAssistantCitation({
    version: 1,
    environmentId: EnvironmentId.make("env"),
    threadId,
    messageId: MessageId.make("assistant"),
    text: excerpt,
    start: 0,
    end: excerpt.length,
    prefix: "",
    suffix: "",
    comment: "Please add the retry here.",
  });

function assertProviderCitation(text: string) {
  assert.include(text, "[assistant-quote-1]");
  assert.include(text, "quoted reference material");
  assert.include(text, '"text": "That path needs a retry."');
  assert.include(text, "user-authored request or comment");
  assert.include(text, '"comment": "Please add the retry here."');
  assert.notInclude(text, "t3-citation://");
}

it.effect.each(
  [false, true]
    .flatMap((mailbox) =>
      (
        [
          "before delivery",
          "during delivery",
          "before dispatch",
          "after delivery",
          "without native steering",
          "native declined",
          "with interrupting native steering",
          "settled only",
          "disk full",
        ] as const
      ).map((timing) => ({
        mailbox,
        timing,
        label: mailbox ? "mailbox notification" : "steering",
      })),
    )
    .filter(
      ({ mailbox, timing }) =>
        (mailbox && timing !== "native declined") ||
        (!mailbox && timing !== "with interrupting native steering" && timing !== "settled only"),
    ),
)("delivers $label when completion wins $timing", ({ mailbox, timing }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(`steering-completion-${timing.replaceAll(" ", "-")}`);
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
      const steerEntered = yield* Deferred.make<void>();
      const rejectSteer = yield* Deferred.make<void>();
      const storageFailed = yield* Deferred.make<void>();
      let fullWrites = 0;
      const databaseLayer = Layer.effect(
        SqlClient.SqlClient,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const withTransaction = sql.withTransaction;
          return Object.assign(sql, {
            withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              Effect.suspend(() => {
                if (fullWrites === 0) return withTransaction(effect);
                fullWrites--;
                return Deferred.succeed(storageFailed, undefined).pipe(
                  Effect.andThen(
                    new SqlError.SqlError({
                      reason: new SqlError.UnknownError({
                        cause: {
                          code: "ERR_SQLITE_ERROR",
                          errcode: 13,
                          errstr: "database or disk is full",
                        },
                      }),
                    }),
                  ),
                );
              }),
          });
        }),
      ).pipe(Layer.provide(SqlitePersistence.layerMemory));
      let steerCalls = 0;
      const capabilities = {
        ...CodexProviderCapabilitiesV2,
        turns: {
          ...CodexProviderCapabilitiesV2.turns,
          supportsActiveSteering: timing !== "without native steering",
          activeSteeringInterruptsTools: timing === "with interrupting native steering",
        },
      };
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(capabilities),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            return {
              instanceId,
              driver,
              providerSessionId: input.providerSessionId,
              providerSession: {
                id: input.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd,
                model: modelSelection.model,
                capabilities,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ensureThread: ({ threadId }) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`provider-thread:${threadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                }),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              startTurn: (turn) =>
                Effect.gen(function* () {
                  started.push(turn);
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                      providerThreadId: turn.providerThread.id,
                      nodeId: turn.rootNodeId,
                      runAttemptId: turn.attemptId,
                      nativeTurnRef: {
                        driver,
                        nativeId: `native:${turn.attemptId}`,
                        strength: "strong",
                      },
                      ordinal: turn.providerTurnOrdinal,
                      status: "running",
                      startedAt: now,
                      completedAt: null,
                    },
                  });
                }),
              steerTurn: (turn) =>
                Effect.gen(function* () {
                  steerCalls += 1;
                  if (timing === "after delivery") return;
                  if (timing === "native declined") {
                    return yield* new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
                      driver,
                      providerThreadId: turn.providerThread.id,
                    });
                  }
                  yield* Deferred.succeed(steerEntered, undefined);
                  yield* Deferred.await(rejectSteer);
                  return yield* new ProviderAdapter.ProviderAdapterSteerRunError({
                    driver,
                    providerThreadId: turn.providerThread.id,
                    providerTurnId: turn.providerTurnId,
                    cause: "turn already completed",
                  });
                }),
              interruptTurn: () => Effect.die("Follow-up delivery must never interrupt"),
              respondToRuntimeRequest: () => Effect.void,
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("thread:steering-completion");
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:steering-completion"),
          title: "Steering race",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("first"),
          threadId,
          messageId: MessageId.make("message:first"),
          text: "first",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const running = yield* watch(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        yield* worker.drain();
        yield* Fiber.join(running);
        const first = started[0]!;
        const messageId = MessageId.make("message:steering");
        const taskId = NodeId.make("task:mailbox");
        if (mailbox) {
          const sink = yield* EventSink.EventSinkV2;
          const current = yield* orchestrator.getThreadProjection(threadId);
          const parentRun = current.runs.find((run) => run.id === first.runId)!;
          const now = yield* DateTime.now;
          yield* sink.write({
            events: [
              {
                id: EventId.make("mailbox:cohort"),
                type: "run.updated",
                threadId,
                runId: first.runId,
                occurredAt: now,
                payload: {
                  ...parentRun,
                  delegatedCompletion: {
                    disposition: "open",
                    nextGeneration: 2,
                    delivery: { generation: 1, messageId, taskIds: [taskId] },
                  },
                },
              },
              {
                id: EventId.make("mailbox:task"),
                type: "subagent.updated",
                threadId,
                runId: first.runId,
                nodeId: taskId,
                occurredAt: now,
                payload: {
                  id: taskId,
                  threadId,
                  runId: first.runId,
                  parentNodeId: first.rootNodeId,
                  origin: "app_owned",
                  createdBy: "agent",
                  driver,
                  providerInstanceId: instanceId,
                  providerThreadId: null,
                  childThreadId: null,
                  nativeTaskRef: null,
                  prompt: "Do background work",
                  title: "Background test",
                  model: null,
                  completionWake: timing === "settled only" ? "settled_only" : "always",
                  completionDelivery: { state: "claimed", observedByRunId: null },
                  status: "completed",
                  result: "done",
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                },
              },
            ],
          });
        }
        const dispatchSteer = orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer"),
          threadId,
          messageId,
          text: "fix the popover",
          attachments: [
            {
              type: "image",
              id: "steering-screenshot",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 10,
            },
          ],
          dispatchMode:
            mailbox || timing === "native declined"
              ? { type: "queue_after_active" }
              : { type: "steer_active", targetRunId: first.runId },
          createdBy: mailbox ? "agent" : "user",
          creationSource: mailbox ? "server" : "web",
          ...(mailbox
            ? {
                delegatedCompletion: {
                  parentRunId: first.runId,
                  generation: 1,
                  taskIds: [taskId],
                },
              }
            : {}),
        });
        if (timing !== "before dispatch") yield* dispatchSteer;
        if (timing === "native declined") {
          const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.userMessageId === messageId && run.status === "queued",
          )!;
          yield* orchestrator.dispatch({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make("promote:first"),
            threadId,
            queuedRunId: queued.id,
            targetRunId: first.runId,
          });
        }
        if (timing === "after delivery") yield* worker.drain();
        if (timing === "without native steering" || timing === "native declined") {
          yield* worker.drain();
          const queued = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(started.length, 1);
          assert.equal(queued.runs[0]?.status, "running");
          const followUp = queued.runs.find(
            (run) => run.userMessageId === messageId && run.status === "queued",
          );
          assert.equal(followUp?.status, "queued");
          if (timing === "native declined") {
            assert.equal(queued.providerTurns[0]?.steeringUnavailable, true);
            assert.isDefined(followUp);
            for (const tap of [1, 2]) {
              const result = yield* orchestrator
                .dispatch({
                  type: "queued-message.promote-to-steer",
                  commandId: CommandId.make(`promote:${tap}`),
                  threadId,
                  queuedRunId: followUp!.id,
                  targetRunId: first.runId,
                })
                .pipe(Effect.flip);
              assert.equal(result._tag, "OrchestratorDispatchError");
            }
            yield* worker.drain();
            assert.equal(steerCalls, 1);
            assert.deepEqual((yield* orchestrator.getThreadProjection(threadId)).runs, queued.runs);
            const requeued = queued.turnItems.find(
              (item) => item.type === "user_message" && item.messageId === messageId,
            );
            assert.deepEqual(
              requeued && {
                status: requeued.status,
                startedAt: requeued.startedAt,
                completedAt: requeued.completedAt,
              },
              { status: "pending", startedAt: null, completedAt: null },
            );
          }
          assert.isFalse(
            queued.turnItems.some(
              (item) =>
                item.type === "user_message" &&
                item.messageId === messageId &&
                (item.inputIntent === "steer" || item.inputIntent === "promoted_queued_to_steer"),
            ),
          );
        }
        const delivery =
          timing === "during delivery" ? yield* worker.runOnce.pipe(Effect.forkScoped) : null;
        if (delivery !== null) yield* Deferred.await(steerEntered);
        const completed = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === first.runId &&
            event.payload.status === "waiting",
        );
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const turn = projection.providerTurns[0]!;
        // If ingestion and its fallback terminal write both fail, the run
        // used to lose its subscription. Retain it through both failures.
        if (timing === "disk full") fullWrites = 2;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        if (timing === "disk full") {
          yield* Deferred.await(storageFailed);
        }
        yield* Fiber.join(completed);
        if (timing === "disk full") assert.equal(fullWrites, 0);
        if (delivery !== null) {
          yield* Deferred.succeed(rejectSteer, undefined);
          yield* Fiber.join(delivery);
        }
        if (timing === "before dispatch") yield* dispatchSteer;
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();
        if (timing === "after delivery") {
          assert.equal(steerCalls, 1);
          assert.equal(started.length, 1);
          if (mailbox) {
            const delivered = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(delivered.subagents[0]?.completionDelivery?.state, "acknowledged");
            assert.equal(delivered.subagents[0]?.completionDelivery?.observedByRunId, first.runId);
            assert.equal(delivered.runs[0]?.delegatedCompletion?.delivery, null);
            assert.equal(
              delivered.turnItems.filter((item) => item.type === "notification").length,
              1,
            );
            yield* orchestrator.dispatch({
              type: "notification.delivery.accept",
              commandId: CommandId.make("duplicate-acceptance"),
              threadId,
              messageId,
            });
            yield* worker.drain();
            assert.equal(steerCalls, 1);
            yield* orchestrator.dispatch({
              type: "delegated_task.completion-delivery.acknowledge",
              commandId: CommandId.make("read-result"),
              parentThreadId: threadId,
              taskId,
              observedByRunId: first.runId,
            });
            const acknowledged = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(acknowledged.subagents[0]?.completionDelivery?.state, "acknowledged");
          }
          return;
        }
        assert.equal(started.length, 2);
        assert.equal(started[1]?.message.messageId, messageId);
        if (mailbox) assert.include(started[1]?.message.text ?? "", String(taskId));
        else assert.equal(started[1]?.message.text, "fix the popover");
        assert.deepEqual(started[1]?.message.attachments, [
          {
            type: "image",
            id: "steering-screenshot",
            name: "image.png",
            mimeType: "image/png",
            sizeBytes: 10,
          },
        ]);
        assert.equal(
          steerCalls,
          timing === "during delivery" || timing === "native declined" ? 1 : 0,
        );
        const final = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(final.messages.filter((message) => message.id === messageId).length, 1);
        assert.equal(
          final.messages.find((message) => message.id === messageId)?.runId,
          started[1]?.runId,
        );
        assert.equal(
          final.turnItems.filter((item) =>
            mailbox
              ? item.type === "notification"
              : item.type === "user_message" && item.messageId === messageId,
          ).length,
          1,
        );
        yield* worker.drain();
        assert.equal(started.length, 2);
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: `steering-completion-${timing}` },
            ProviderAdapterRegistry.layerSingle(adapter),
            { runEffectWorker: false, ...(timing === "disk full" ? { databaseLayer } : {}) },
          ),
        ),
      );
    }),
  ).pipe((effect) => (timing === "disk full" ? TestClock.withLive(effect) : effect)),
);

// A changed selection the provider applies on its next turn waits there as the
// thread's saved selection. That holds for a provider that can restart the
// turn (Codex) too: restarting it would end the turn's native subagents.
const runSelection = {
  instanceId,
  model: "test-model",
  options: [{ id: "effort", value: "xhigh" }],
};
const composerSelection = {
  ...runSelection,
  options: [...runSelection.options, { id: "fastMode", value: false }],
};

const nextTurnSelectionHarness = Effect.fn("nextTurnSelectionHarness")(function* (
  name: string,
  canRestart = false,
  transition: "apply_on_next_turn" | "restart_session" = "apply_on_next_turn",
  steerUnavailable = false,
) {
  const cwd = yield* checkpointWorkspace(name);
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
  const steered: string[] = [];
  const capabilities = {
    ...CodexProviderCapabilitiesV2,
    turns: {
      ...CodexProviderCapabilitiesV2.turns,
      supportsActiveSteering: true,
      supportsSteeringByInterruptRestart: canRestart,
    },
  };
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: transition }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const startTurn = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
          Effect.gen(function* () {
            started.push(turn);
            yield* Queue.offer(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: {
                id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                providerThreadId: turn.providerThread.id,
                nodeId: turn.rootNodeId,
                runAttemptId: turn.attemptId,
                nativeTurnRef: {
                  driver,
                  nativeId: `native:${turn.attemptId}`,
                  strength: "strong",
                },
                ordinal: turn.providerTurnOrdinal,
                status: "running",
                startedAt: now,
                completedAt: null,
                ...(steerUnavailable && started.length === 1
                  ? { steeringUnavailable: true as const }
                  : {}),
              },
            });
          });
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd,
            model: runSelection.model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn,
          steerTurn: (turn) =>
            Effect.sync(() => {
              steered.push(turn.message.text);
            }),
          // A /compact turn runs like any other turn here.
          compactThread: startTurn,
          // A restart waits for the interrupted turn to end, as a provider reports it.
          // Without restarts the tests keep Stop short of the provider.
          interruptTurn: ({ providerThread, providerTurnId }) =>
            Effect.gen(function* () {
              if (!canRestart) return;
              const turn = started.find(
                (candidate) => `provider-turn:${candidate.attemptId}` === providerTurnId,
              );
              if (turn === undefined) return;
              const endedAt = yield* DateTime.now;
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: {
                    driver,
                    nativeId: `native:${turn.attemptId}`,
                    strength: "strong",
                  },
                  ordinal: turn.providerTurnOrdinal,
                  status: "interrupted",
                  startedAt: now,
                  completedAt: endedAt,
                },
              });
              yield* Queue.offer(events, {
                type: "turn.terminal",
                driver,
                providerThreadId: providerThread.id,
                providerTurnId,
                runOrdinal: turn.runOrdinal,
                status: "interrupted",
                failure: null,
                threadDisposition: "reusable",
              });
            }),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name },
    ProviderAdapterRegistry.layerSingle(adapter),
    { runEffectWorker: false },
  );
  // Creates the thread and starts its first turn on `runSelection`.
  const startFirstTurnWithText = Effect.fnUntraced(function* (text: string) {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make(`project:${name}`),
      title: "Steer with changed options",
      modelSelection: runSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    const running = yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter(
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("first"),
      threadId,
      messageId: MessageId.make("message:first"),
      text,
      attachments: [],
      modelSelection: runSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* worker.drain();
    yield* Fiber.join(running);
    return threadId;
  });
  return {
    events,
    started,
    steered,
    layer,
    startFirstTurn: startFirstTurnWithText("first"),
    startFirstTurnWithText,
  };
});

it.effect.each(["steer_active", "restart_active"] as const)(
  "delivers a cited message on start and %s while storing the original links",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = `citation-${mode}`;
        const { started, steered, layer, startFirstTurnWithText } = yield* nextTurnSelectionHarness(
          name,
          true,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const citation = citedInput(ThreadId.make(`thread:${name}`));
          const firstText = `Read ${citation}`;
          const nextText = `Use ${citation}`;
          const threadId = yield* startFirstTurnWithText(firstText);
          const first = started[0]!;
          assertProviderCitation(first.message.text);

          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("next"),
            threadId,
            messageId: MessageId.make("message:next"),
            text: nextText,
            attachments: [],
            dispatchMode: { type: mode, targetRunId: first.runId },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();

          assertProviderCitation(mode === "steer_active" ? steered[0]! : started[1]!.message.text);
          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            projection.messages.map((message) => message.text),
            [firstText, nextText],
          );
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect.each(["live", "deferred", "promoted"] as const)(
  "rejects oversized citation expansion before committing a %s steer",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          `oversized-citation-${mode}`,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const sink = yield* EventSink.EventSinkV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          const targetRunId = started[0]!.runId;
          const text = `${"x".repeat(80_000)}${citedInput(threadId, "\u0001".repeat(8_000))}`;
          assert.isBelow(text.length, PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
          assert.isAbove(
            expandAssistantCitationsForProvider(text).length,
            PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
          );
          if (mode === "deferred") {
            const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
            yield* sink.write({
              events: [
                {
                  id: EventId.make("turn-not-ready"),
                  type: "provider-turn.updated",
                  threadId,
                  occurredAt: yield* DateTime.now,
                  payload: { ...turn, status: "pending" },
                },
              ],
            });
          }
          let command: Parameters<typeof orchestrator.dispatch>[0] = {
            type: "message.dispatch",
            commandId: CommandId.make("oversized"),
            threadId,
            messageId: MessageId.make("message:oversized"),
            text,
            attachments: [],
            dispatchMode: { type: "steer_active", targetRunId },
            createdBy: "user",
            creationSource: "web",
          };
          if (mode === "promoted") {
            yield* orchestrator.dispatch({
              ...command,
              commandId: CommandId.make("queue"),
              dispatchMode: { type: "queue_after_active" },
            });
            const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
              (run) => run.status === "queued",
            )!;
            command = {
              type: "queued-message.promote-to-steer",
              commandId: CommandId.make("oversized"),
              threadId,
              queuedRunId: queued.id,
              targetRunId,
            };
          }
          const before = yield* orchestrator.getThreadProjection(threadId);
          const sequence = yield* orchestrator.getThreadEventSequence(threadId);

          const error = yield* orchestrator.dispatch(command).pipe(Effect.flip);
          yield* worker.drain();

          assert.instanceOf(error, Orchestrator.OrchestratorCommandRejectedError);
          assert.equal(
            error.cause,
            "Message exceeds 120,000 characters after expanding quotes. Shorten it and try again.",
          );
          assert.equal(yield* orchestrator.getThreadEventSequence(threadId), sequence);
          assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), before);
          assert.lengthOf(started, 1);
          assert.isEmpty(steered);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect.each(["interrupt", "hold", "send-now"] as const)(
  "delivers the original queued run after %s",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          `unsteerable-queue-${mode}`,
          true,
          "apply_on_next_turn",
          true,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          const sink = yield* EventSink.EventSinkV2;
          const afterSequence = yield* sink.latestSequence();
          const first = started[0]!;
          const citation = citedInput(threadId);
          for (const id of ["next", "later"]) {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(id),
              threadId,
              messageId: MessageId.make(id),
              text: `${id} ${citation}`,
              attachments: [],
              dispatchMode: { type: "steer_active", targetRunId: first.runId },
              createdBy: "user",
              creationSource: "web",
            });
          }
          yield* worker.drain();
          const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.filter(
            (run) => run.status === "queued",
          );
          assert.lengthOf(queued, 2);
          const selected = queued[mode === "send-now" ? 1 : 0]!;
          const command = {
            type: "run.interrupt",
            commandId: CommandId.make("interrupt"),
            threadId,
            runId: first.runId,
            keepHelpers: true,
            ...(mode === "send-now" ? { sendQueuedRunId: selected.id } : {}),
          } as const;
          yield* orchestrator.dispatch(
            mode === "hold"
              ? {
                  type: "thread.stop",
                  commandId: command.commandId,
                  threadId,
                  // This fake provider has no delegated tasks to stop.
                  stopDelegatedTasks: false,
                }
              : command,
          );
          if (mode === "send-now") {
            yield* orchestrator.dispatch(command);
            const competing = yield* orchestrator
              .dispatch({
                ...command,
                commandId: CommandId.make("competing"),
                sendQueuedRunId: queued[0]!.id,
              })
              .pipe(Effect.flip);
            assert.equal(competing._tag, "OrchestratorDispatchError");
          }
          yield* worker.drain();
          if (mode === "hold") {
            const held = yield* orchestrator.getThreadProjection(threadId);
            assert.deepEqual(
              held.runs.map((run) => run.status),
              ["interrupted", "queued", "queued"],
            );
            assert.isTrue(held.runs.slice(1).every((run) => run.queueHeld === true));
            assert.lengthOf(started, 1);
            yield* orchestrator.dispatch({
              type: "queue.resume",
              commandId: CommandId.make("send-held"),
              threadId,
            });
          }
          yield* sink.stream({ afterSequence }).pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "run.updated" &&
                event.payload.id === selected.id &&
                event.payload.status === "starting",
            ),
            Stream.take(1),
            Stream.runDrain,
          );
          yield* worker.drain();
          const after = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, []);
          assert.deepEqual(
            started.map((turn) => turn.runId),
            [first.runId, selected.id],
          );
          assert.equal(started[1]?.message.messageId, selected.userMessageId);
          assertProviderCitation(started[1]!.message.text);
          assert.include(
            after.messages.find((message) => message.id === selected.userMessageId)!.text,
            citation,
          );
          assert.lengthOf(after.runs, 3);
          assert.isUndefined(after.runs.find((run) => run.id === selected.id)?.sendNext);
          assert.isFalse(
            after.runs.some((run) => run.status === "queued" && run.queueHeld === true),
          );
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect.each(
  [false, true].flatMap((canRestart) =>
    (["apply_on_next_turn", "restart_session"] as const).map((transition) => ({
      canRestart,
      transition,
    })),
  ),
)(
  "steers a changed selection without restarting (canRestart=$canRestart, transition=$transition)",
  ({ canRestart, transition }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          `steering-selection-change-${canRestart}`,
          canRestart,
          transition,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          const steer = (id: string, selection: ModelSelection) =>
            orchestrator
              .dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(id),
                threadId,
                messageId: MessageId.make(`message:${id}`),
                text: id,
                attachments: [],
                modelSelection: selection,
                dispatchMode: { type: "steer_active", targetRunId: started[0]!.runId },
                createdBy: "user",
                creationSource: "web",
              })
              .pipe(Effect.andThen(worker.drain()));

          yield* steer("steer-changed", composerSelection);
          const changed = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, ["steer-changed"]);
          assert.equal(started.length, 1);
          assert.lengthOf(changed.attempts, 1);
          assert.equal(changed.runs[0]?.status, "running");
          assert.deepEqual(changed.runs[0]?.modelSelection, runSelection);
          assert.deepEqual(changed.thread.modelSelection, composerSelection);

          // Choosing the running run's selection again replaces the saved choice.
          yield* steer("steer-reverted", runSelection);
          const reverted = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, ["steer-changed", "steer-reverted"]);
          assert.lengthOf(reverted.attempts, 1);
          assert.deepEqual(reverted.thread.modelSelection, runSelection);

          // The saved choice moves to another instance while the run keeps going.
          // Steering with the run's selection brings the thread's instance back too.
          const otherSelection = {
            instanceId: ProviderInstanceId.make("codex-work"),
            model: "other",
          };
          const sink = yield* EventSink.EventSinkV2;
          yield* sink.write({
            events: [
              {
                id: EventId.make("switched-away"),
                type: "thread.provider-switched",
                threadId,
                providerInstanceId: otherSelection.instanceId,
                occurredAt: yield* DateTime.now,
                payload: {
                  ...reverted.thread,
                  providerInstanceId: otherSelection.instanceId,
                  modelSelection: otherSelection,
                },
              },
            ],
          });
          yield* steer("steer-back", runSelection);
          const back = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, ["steer-changed", "steer-reverted", "steer-back"]);
          assert.equal(back.thread.providerInstanceId, instanceId);
          assert.deepEqual(back.thread.modelSelection, runSelection);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

// regression: upstream #33454 a restart of a completion wake run left its cohort claimed forever
it.effect("wakes the parent for a sibling result after a send restarts the completion wake", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* nextTurnSelectionHarness("steered-completion-wake", true);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sink = yield* EventSink.EventSinkV2;
        const threadId = yield* harness.startFirstTurn;
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        const watchTurnRunning = (ordinal: number) =>
          watch(
            (event) =>
              event.type === "provider-turn.updated" &&
              event.payload.status === "running" &&
              event.payload.ordinal === ordinal,
          );
        const finishTurn = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
          Effect.gen(function* () {
            const providerTurn = (yield* orchestrator.getThreadProjection(
              threadId,
            )).providerTurns.find((candidate) => candidate.runAttemptId === turn.attemptId)!;
            const settled = yield* watch(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === turn.runId &&
                (event.payload.status === "completed" || event.payload.status === "waiting"),
            );
            yield* Queue.offer(harness.events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: {
                ...providerTurn,
                status: "completed",
                completedAt: yield* DateTime.now,
              },
            });
            yield* Queue.offer(harness.events, {
              type: "turn.terminal",
              driver,
              providerThreadId: providerTurn.providerThreadId,
              providerTurnId: providerTurn.id,
              runOrdinal: turn.runOrdinal,
              status: "completed",
              failure: null,
              threadDisposition: "reusable",
            });
            yield* Fiber.join(settled);
            yield* worker.drain();
          });

        const origin = harness.started[0]!;
        const firstTaskId = NodeId.make("task:steered-wake-first");
        const siblingTaskId = NodeId.make("task:steered-wake-sibling");
        const now = yield* DateTime.now;
        // Both tasks finished while the origin turn ran; each wakes the parent once its policy says so.
        yield* sink.write({
          events: [firstTaskId, siblingTaskId].map((taskId) => ({
            id: EventId.make(`event:seed:${taskId}`),
            type: "subagent.updated" as const,
            threadId,
            runId: origin.runId,
            nodeId: taskId,
            occurredAt: now,
            payload: {
              id: taskId,
              threadId,
              runId: origin.runId,
              parentNodeId: origin.rootNodeId,
              origin: "app_owned" as const,
              createdBy: "agent" as const,
              driver,
              providerInstanceId: instanceId,
              providerThreadId: null,
              childThreadId: null,
              nativeTaskRef: null,
              prompt: "Do background work",
              title: null,
              model: null,
              completionWake: "settled_only" as const,
              completionDelivery: { state: "pending" as const, observedByRunId: null },
              status: "completed" as const,
              result: `${taskId} finished`,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
            },
          })),
        });
        yield* finishTurn(origin);
        const release = (taskId: NodeId) =>
          orchestrator.dispatch({
            type: "delegated_task.wake-policy",
            commandId: CommandId.make(`command:wake-policy:${taskId}`),
            parentThreadId: threadId,
            taskId,
            completionWake: "always",
          });
        yield* release(firstTaskId);
        const firstDelivery = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.id === origin.runId,
        )!.delegatedCompletion!.delivery!;
        assert.deepEqual(firstDelivery.taskIds, [firstTaskId]);
        const wakeRunning = yield* watchTurnRunning(2);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("command:first-wake"),
          threadId,
          messageId: firstDelivery.messageId,
          text: "Delegated task completed",
          attachments: [],
          modelSelection: runSelection,
          dispatchMode: { type: "queue_after_active" },
          delegatedCompletion: {
            parentRunId: origin.runId,
            generation: firstDelivery.generation,
            taskIds: firstDelivery.taskIds,
          },
          createdBy: "agent",
          creationSource: "server",
        });
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();
        yield* Fiber.join(wakeRunning);
        const wake = harness.started[1]!;
        assert.equal(wake.message.messageId, firstDelivery.messageId);

        // The sender asks to restart the wake run with its message.
        const steeredRunning = yield* watchTurnRunning(3);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("command:steer-wake"),
          threadId,
          messageId: MessageId.make("message:steer-wake"),
          text: "also check the logs",
          attachments: [],
          modelSelection: runSelection,
          dispatchMode: { type: "restart_active", targetRunId: wake.runId },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* Fiber.join(steeredRunning);
        const steered = harness.started[2]!;
        assert.equal(steered.runId, wake.runId);
        yield* finishTurn(steered);

        yield* release(siblingTaskId);
        const final = yield* orchestrator.getThreadProjection(threadId);
        const tasks = new Map(
          final.subagents.map((task) => [task.id, task.completionDelivery?.state]),
        );
        assert.deepInclude(
          final.runs.find((run) => run.id === origin.runId)?.delegatedCompletion?.delivery ?? {},
          { generation: 2, taskIds: [siblingTaskId] },
          "the sibling finished after the steered wake but no new completion wake was reserved",
        );
        assert.equal(tasks.get(siblingTaskId), "claimed");
        assert.equal(tasks.get(firstTaskId), "acknowledged");
      }).pipe(Effect.provide(harness.layer));
    }),
  ),
);

it.effect("delivers agent messages queued behind /compact before a later one steers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "agent-order-after-compact",
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const nextRunning = Effect.fn("nextRunning")(function* () {
          return yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "provider-turn.updated" && event.payload.status === "running",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        });
        const finishTurn = Effect.fn("finishTurn")(function* (index: number) {
          const turnInput = started[index]!;
          const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns.find(
            (candidate) => candidate.runAttemptId === turnInput.attemptId,
          )!;
          const settled = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === turnInput.runId &&
                (event.payload.status === "waiting" || event.payload.status === "completed"),
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
          });
          yield* Queue.offer(events, {
            type: "turn.terminal",
            driver,
            providerThreadId: turn.providerThreadId,
            providerTurnId: turn.id,
            runOrdinal: turnInput.runOrdinal,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* Fiber.join(settled);
          yield* worker.drain();
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();
        });
        yield* finishTurn(0);
        const compactRunning = yield* nextRunning();
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("compact"),
          threadId,
          messageId: MessageId.make("message:compact"),
          text: "/compact",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* Fiber.join(compactRunning);
        const sendFromAgent = (codeword: string) =>
          Effect.gen(function* () {
            const active = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
              (run) => run.status === "running",
            )!;
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`send-${codeword}`),
              threadId,
              messageId: MessageId.make(`message:${codeword}`),
              text: codeword,
              attachments: [],
              dispatchMode: { type: "steer_active", targetRunId: active.id },
              deliveryIntent: "auto",
              createdBy: "agent",
              creationSource: "mcp",
              senderThreadId: ThreadId.make("thread:orchestrator"),
            });
            yield* worker.drain();
          });
        yield* sendFromAgent("ALPHA");
        yield* sendFromAgent("BRAVO");
        const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.filter(
          (run) => run.status === "queued",
        );
        assert.lengthOf(queued, 2);
        assert.deepEqual(steered, []);
        const alphaRunning = yield* nextRunning();
        yield* finishTurn(1);
        yield* Fiber.join(alphaRunning);
        assert.deepEqual(
          started.map((turn) => turn.message.text.split("\n").at(-1)),
          ["first", "/compact", "ALPHA"],
        );

        yield* sendFromAgent("CHARLIE");
        const delivered = [...steered, ...started.slice(3).map((turn) => turn.message.text)]
          .map((text) => text.split("\n").at(-1))
          .filter((text) => text === "BRAVO" || text === "CHARLIE");
        // Whatever reaches the agent so far does so in send order: CHARLIE never before BRAVO.
        assert.deepEqual(delivered, ["BRAVO", "CHARLIE"].slice(0, delivered.length));
        assert.notInclude(steered, "CHARLIE");
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("an agent's auto send steers past its explicitly queued message", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = "agent-auto-after-explicit-queue";
      const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(name);
      const managerLayer = ThreadManagementService.layer.pipe(
        Layer.provideMerge(layer),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const manager = yield* ThreadManagementService.ThreadManagementService;
        const threadId = yield* startFirstTurn;
        const send = (text: string, mode: "auto" | "queue") =>
          manager.sendToThread({
            projectId: ProjectId.make(`project:${name}`),
            threadId,
            commandId: CommandId.make(text),
            messageId: MessageId.make(text),
            text,
            attachments: [],
            mode,
            createdBy: "agent",
            creationSource: "mcp",
            senderThreadId: ThreadId.make("thread:sender"),
          });
        const later = yield* send("later", "queue");
        const now = yield* send("now", "auto");
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(later.delivery, "queued");
        assert.equal(now.delivery, "steered");
        assert.equal(now.run.id, started[0]?.runId);
        assert.deepEqual(
          steered.map((text) => text.split("\n").at(-1)),
          ["now"],
        );
        assert.deepEqual(
          projection.runs.filter((run) => run.status === "queued").map((run) => run.id),
          [later.run.id],
        );
      }).pipe(Effect.provide(managerLayer));
    }),
  ),
);

it.effect.each(["user", "agent"] as const)(
  "delivers a missed steer on the saved next-turn selection · %s",
  (actor) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          "steering-selection-follow-up",
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          const first = started[0]!;
          const sender = ThreadId.make("late-steer-sender");
          if (actor === "agent") {
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("create-sender"),
              threadId: sender,
              projectId: ProjectId.make("project:steering-selection-follow-up"),
              title: "Sender",
              modelSelection: runSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdBy: "user",
              creationSource: "web",
            });
          }
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("steer"),
            threadId,
            messageId: MessageId.make("message:steer"),
            text: "late steer",
            attachments: [],
            modelSelection: composerSelection,
            dispatchMode: { type: "steer_active", targetRunId: first.runId },
            createdBy: actor,
            creationSource: actor === "user" ? "web" : "mcp",
            ...(actor === "agent" && { senderThreadId: sender, notifySenderOnCompletion: true }),
          });
          // The turn ends before the worker delivers the steer, so the steer
          // becomes a follow-up turn.
          const finish = Effect.fnUntraced(function* (input: typeof first) {
            const settled = yield* orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (event) =>
                  event.type === "run.updated" &&
                  event.payload.id === input.runId &&
                  event.payload.status === "waiting",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
            const running = yield* orchestrator
              .streamStoredEventsFrom({
                threadId,
                eventType: "provider-turn.updated",
                afterSequence: 0,
              })
              .pipe(
                Stream.map(({ event }) => event),
                Stream.filter((event) => event.type === "provider-turn.updated"),
                Stream.filter(
                  (event) =>
                    event.payload.runAttemptId === input.attemptId &&
                    event.payload.status === "running",
                ),
                Stream.runHead,
              );
            const turn = Option.getOrThrow(running).payload;
            yield* Queue.offer(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
            });
            yield* Queue.offer(events, {
              type: "turn.terminal",
              driver,
              providerThreadId: turn.providerThreadId,
              providerTurnId: turn.id,
              runOrdinal: input.runOrdinal,
              status: "completed",
              failure: null,
              threadDisposition: "reusable",
            });
            yield* Fiber.join(settled);
            yield* worker.drain();
          });
          yield* finish(first);
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();

          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, []);
          assert.equal(started.length, 2);
          assert.equal(started[1]?.message.messageId, MessageId.make("message:steer"));
          assert.deepEqual(started[1]?.modelSelection, composerSelection);
          assert.deepEqual(projection.thread.modelSelection, composerSelection);
          const message = projection.turnItems.find(
            (item) =>
              item.type === "user_message" && item.messageId === MessageId.make("message:steer"),
          );
          assert.equal(message?.runId, started[1]!.runId);
          assert.isAbove(
            message!.ordinal,
            Math.max(
              ...projection.turnItems
                .filter((item) => item.runId === first.runId)
                .map((item) => item.ordinal),
            ),
          );
          if (actor === "agent") {
            assert.isEmpty((yield* orchestrator.getThreadProjection(sender)).messages);
            yield* finish(started[1]!);
            const notices = (yield* orchestrator.getThreadProjection(sender)).messages;
            assert.lengthOf(notices, 1);
            assert.equal(notices[0]?.text, `Thread ${threadId} run 2 completed`);
          }
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect("steers a promoted queued message with the selection it was queued with", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "promote-queued-selection",
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const citation = citedInput(threadId);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("queued"),
          threadId,
          messageId: MessageId.make("message:queued"),
          text: citation,
          attachments: [],
          modelSelection: composerSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const queuedRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.status === "queued",
        )!;
        yield* orchestrator.dispatch({
          type: "queued-message.promote-to-steer",
          commandId: CommandId.make("promote"),
          threadId,
          queuedRunId: queuedRun.id,
          targetRunId: started[0]!.runId,
        });
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(steered, 1);
        assertProviderCitation(steered[0]!);
        assert.equal(
          projection.messages.find((message) => message.id === queuedRun.userMessageId)?.text,
          citation,
        );
        assert.deepEqual(projection.thread.modelSelection, composerSelection);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("shows a steer to an agent that only waits as a new message and restarts its clock", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, steered, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("steer-waiting-agent");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const runId = started[0]!.runId;
        const steer = (id: string) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(id),
            threadId,
            messageId: MessageId.make(`message:${id}`),
            text: id,
            attachments: [],
            modelSelection: runSelection,
            dispatchMode: { type: "steer_active", targetRunId: runId },
            createdBy: "user",
            creationSource: "mobile",
          });
        const userItem = (id: string) =>
          orchestrator
            .getThreadProjection(threadId)
            .pipe(
              Effect.map((projection) =>
                projection.turnItems.find(
                  (item) =>
                    item.type === "user_message" &&
                    item.messageId === MessageId.make(`message:${id}`),
                ),
              ),
            );

        yield* steer("busy");
        yield* worker.drain();
        const busy = yield* userItem("busy");
        assert.equal(busy?.type === "user_message" && busy.inputIntent, "steer");
        assert.isUndefined(busy?.type === "user_message" ? busy.agentWasWaiting : null);
        const before = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.id === runId,
        )!;
        assert.isUndefined(before.workStartedAt);

        // The reply ended and a timer holds the prompt open, as `agy acp` 1.5.15+ does.
        const providerThread = (yield* orchestrator.getThreadProjection(threadId))
          .providerThreads[0]!;
        const waiting = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "provider-thread.updated" &&
              event.payload.waitingOnBackgroundWork === true,
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* Queue.offer(events, {
          type: "provider_thread.updated",
          driver,
          providerThread: {
            ...providerThread,
            pendingBackgroundTasks: [{ taskId: "timer", kind: "background_task" }],
            waitingOnBackgroundWork: true,
            backgroundWaitStartedAt: DateTime.formatIso(yield* DateTime.now),
          },
        });
        yield* Fiber.join(waiting);
        assert.equal(
          (yield* orchestrator.getThreadShell(threadId))?.backgroundWaitStartedAt,
          DateTime.formatIso(yield* DateTime.now),
        );
        yield* TestClock.adjust("1 hour");

        yield* steer("waiting");
        yield* worker.drain();
        assert.deepEqual(steered, ["busy", "waiting"]);
        const sent = yield* userItem("waiting");
        // Still a steer underneath, so a restart re-sends it if the agent hadn't read it.
        assert.equal(sent?.type === "user_message" && sent.inputIntent, "steer");
        assert.equal(sent?.type === "user_message" && sent.agentWasWaiting, true);
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const run = projection.runs.find((candidate) => candidate.id === runId)!;
        assert.equal(run.status, "running");
        assert.equal(
          run.workStartedAt === undefined ? null : DateTime.formatIso(run.workStartedAt),
          DateTime.formatIso(yield* DateTime.now),
        );

        // The provider finishes from the run snapshot it took before either steer.
        const settled = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.runId === runId &&
              event.payload.status === "waiting",
          ),
          Stream.take(1),
          Stream.runHead,
          Effect.forkScoped,
        );
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: providerThread.id,
          providerTurnId: projection.providerTurns[0]!.id,
          runOrdinal: started[0]!.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        const event = Option.getOrThrow(yield* Fiber.join(settled));
        assert.deepEqual(
          event.type === "run.updated" && event.payload.workStartedAt,
          run.workStartedAt,
        );
        yield* worker.drain();
        const completed = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (candidate) => candidate.id === runId,
        )!;
        assert.equal(completed.status, "completed");
        assert.deepEqual(completed.workStartedAt, run.workStartedAt);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("keeps a queued message queued when promoted into a run that Stop reached", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("steering-after-stop");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("queued"),
          threadId,
          messageId: MessageId.make("message:queued"),
          text: "queued",
          attachments: [],
          modelSelection: runSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const queuedRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.status === "queued",
        )!;
        // The worker has not delivered the interrupt yet, so the run still reads as running.
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop"),
          threadId,
          runId: first.runId,
          holdQueue: true,
        });

        const promoteError = yield* orchestrator
          .dispatch({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make("promote"),
            threadId,
            queuedRunId: queuedRun.id,
            targetRunId: first.runId,
          })
          .pipe(Effect.flip);
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(promoteError._tag, "OrchestratorDispatchError");
        assert.deepEqual(steered, []);
        const queued = projection.runs.find((run) => run.id === queuedRun.id);
        assert.equal(queued?.status, "queued");
        assert.isTrue(queued?.queueHeld);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("queues a plain send behind the stopped queue and releases its hold", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("plain-send-after-stop");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const send = (id: string, delivery: "queue" | "auto") =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(id),
            threadId,
            messageId: MessageId.make(`message:${id}`),
            text: id,
            attachments: [],
            modelSelection: runSelection,
            ...(delivery === "queue"
              ? { dispatchMode: { type: "queue_after_active" } }
              : { dispatchMode: { type: "start_immediately" }, deliveryIntent: "auto" }),
            createdBy: "user",
            creationSource: "web",
          });
        yield* send("queued", "queue");
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop"),
          threadId,
          runId: started[0]!.runId,
          holdQueue: true,
        });
        // The provider has not stopped yet, so a plain send still resolves to a steer.
        yield* send("sent", "auto");
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(steered, []);
        assert.equal(started.length, 1);
        const queued = projection.runs
          .filter((run) => run.status === "queued")
          .sort((left, right) => (left.queuePosition ?? 0) - (right.queuePosition ?? 0));
        assert.deepEqual(
          queued.map(
            (run) => projection.messages.find((message) => message.id === run.userMessageId)?.text,
          ),
          ["queued", "sent"],
        );
        // The user sent it, so the queue they stopped runs again once the provider stops.
        assert.isFalse(queued.some((run) => run.queueHeld === true));
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect.each(["steer", "queue", "held", "late-steer"] as const)(
  "preserves debug context through %s delivery and expands it only for the provider",
  (delivery) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          `debug-context-${delivery}`,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          const first = started[0]!;
          const debug = expandDebugCommand("/debug stale phone");
          const messageId = MessageId.make("debug-message");
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("debug-send"),
            threadId,
            messageId,
            ...debug,
            attachments: [],
            modelSelection: runSelection,
            dispatchMode:
              delivery === "steer" || delivery === "late-steer"
                ? { type: "steer_active", targetRunId: first.runId }
                : { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "mobile",
          });
          if (delivery === "steer") {
            yield* worker.drain();
            assert.include(steered[0]!, "Reproduce it now, then pick Done");
            assert.equal(steered[0]?.match(/Debug workflow:/g)?.length, 1);
          } else {
            if (delivery === "held") {
              const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
                (run) => run.status === "queued",
              )!;
              const sink = yield* EventSink.EventSinkV2;
              yield* sink.write({
                events: [
                  {
                    id: EventId.make("hold-debug"),
                    type: "run.updated",
                    threadId,
                    runId: queued.id,
                    occurredAt: yield* DateTime.now,
                    payload: { ...queued, queueHeld: true },
                  },
                ],
              });
            }
            const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
            const settled = yield* orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (event) =>
                  event.type === "run.updated" &&
                  event.payload.id === first.runId &&
                  event.payload.status === "waiting",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
            yield* Queue.offer(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
            });
            yield* Queue.offer(events, {
              type: "turn.terminal",
              driver,
              providerThreadId: turn.providerThreadId,
              providerTurnId: turn.id,
              runOrdinal: first.runOrdinal,
              status: "completed",
              failure: null,
              threadDisposition: "reusable",
            });
            yield* Fiber.join(settled);
            yield* worker.drain();
            if (delivery === "held") {
              assert.equal(started.length, 1);
              yield* orchestrator.dispatch({
                type: "queue.resume",
                commandId: CommandId.make("resume-debug"),
                threadId,
              });
            }
            yield* orchestrator.resumeQueuedRuns;
            yield* worker.drain();
            assert.equal(started.length, 2);
            assert.include(started[1]!.message.text, "Reproduce it now, then pick Done");
            assert.equal(started[1]!.message.text.match(/Debug workflow:/g)?.length, 1);
          }
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const message = projection.messages.find((message) => message.id === messageId);
          assert.equal(message?.text, debug.text);
          assert.deepEqual(message?.context, debug.context);
          const item = projection.turnItems.find(
            (item) => item.type === "user_message" && item.messageId === messageId,
          );
          assert.isDefined(item);
          if (item?.type === "user_message") {
            assert.equal(item.text, debug.text);
            assert.deepEqual(item.context, debug.context);
          }
          assert.notInclude(JSON.stringify(message), "hypotheses");
        }).pipe(Effect.provide(layer));
      }),
    ),
);
