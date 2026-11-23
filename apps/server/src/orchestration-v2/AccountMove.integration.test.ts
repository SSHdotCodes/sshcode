import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 as caps } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { makeTestAdapter, type CapturedTurn } from "./testkit/ProviderSwitch.testkit.ts";

const driver = ProviderDriverKind.make("codex");
const old = { instanceId: ProviderInstanceId.make("codex"), model: "fixture-model" };
const target = { ...old, instanceId: ProviderInstanceId.make("codex_work") };
const projectId = ProjectId.make("account-move-project");
const root = ThreadId.make("account-move-root");

const send = (
  threadId: ThreadId,
  text: string,
  modelSelection = old,
  queued = false,
  preparing = false,
) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (o) =>
    o.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(text),
      threadId,
      text,
      messageId: MessageId.make(text),
      attachments: [],
      modelSelection,
      dispatchMode: preparing
        ? { type: "defer_start", workspaceStrategy: { type: "root" } }
        : { type: queued ? "queue_after_active" : "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    }),
  );

const watch = Effect.fnUntraced(function* (
  predicate: (event: OrchestrationV2DomainEvent) => boolean,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  return yield* orchestrator.streamDomainEvents.pipe(
    Stream.filter(predicate),
    Stream.take(1),
    Stream.runDrain,
    Effect.forkScoped({ startImmediately: true }),
  );
});

const cases = [
  "running",
  "queue",
  "waiting",
  "completed-awaiting",
  "child",
  "parent",
  "next-model",
  "stop-after-settle",
  "stop",
  "late-refusal",
  "other-model",
  "starting",
  "preparing",
  "stop-before-start",
  "fallback",
] as const;
const unavailableCases = ["signed-out", "limited", "disabled"] as const;
type Scenario = (typeof cases)[number] | (typeof unavailableCases)[number];

const accountMoveFixture = Effect.fnUntraced(function* (scenario: Scenario) {
  const captured = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
  const interrupts: ProviderTurnId[] = [];
  const completeSourceTurn = new Map<ThreadId, Effect.Effect<void>>();
  const interruptEntered = yield* Deferred.make<void>();
  const allowInterrupt = yield* Deferred.make<void>();
  const adapter = (modelSelection: ModelSelection) =>
    makeTestAdapter({
      driver,
      instanceId: modelSelection.instanceId,
      capabilities: caps,
      modelSelection,
      capturedTurns: captured,
      responseByRunOrdinal: {},
      failResume: scenario === "fallback" && modelSelection === target,
      ...(scenario === "late-refusal" ? { limitedRunOrdinals: new Set([2]) } : {}),
    });
  const base = adapter(old);
  const source: ProviderAdapter.ProviderAdapterV2["Service"] = {
    ...base,
    openSession: (input) =>
      Effect.gen(function* () {
        const session = yield* base.openSession(input);
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const turns = new Map<ProviderTurnId, OrchestrationV2ProviderTurn>();
        return {
          ...session,
          events: Stream.fromPubSub(events),
          startTurn: (input) =>
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              const turn: OrchestrationV2ProviderTurn = {
                id: ProviderTurnId.make(`native-turn:${input.runId}`),
                providerThreadId: input.providerThread.id,
                nodeId: input.rootNodeId,
                runAttemptId: input.attemptId,
                nativeTurnRef: null,
                ordinal: input.providerTurnOrdinal,
                status: "running",
                startedAt: now,
                completedAt: null,
              };
              turns.set(turn.id, turn);
              completeSourceTurn.set(
                input.providerThread.appThreadId!,
                Effect.gen(function* () {
                  const now = yield* DateTime.now;
                  yield* PubSub.publish(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: { ...turn, status: "completed", completedAt: now },
                  });
                  yield* PubSub.publish(events, {
                    type: "turn.terminal",
                    driver,
                    providerTurnId: turn.id,
                    providerThreadId: turn.providerThreadId,
                    runOrdinal: turn.ordinal,
                    status: "completed",
                    failure: null,
                    threadDisposition: "reusable",
                  });
                }),
              );
              yield* PubSub.publish(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: turn,
              });
            }),
          interruptTurn: (input) =>
            Effect.gen(function* () {
              interrupts.push(input.providerTurnId);
              yield* Deferred.succeed(interruptEntered, undefined);
              yield* Deferred.await(allowInterrupt);
              const turn = turns.get(input.providerTurnId);
              if (!turn) return;
              // Some providers report a stream failure while shutting down.
              const now = yield* DateTime.now;
              yield* PubSub.publish(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  ...turn,
                  status:
                    scenario === "running"
                      ? "failed"
                      : scenario === "child"
                        ? "cancelled"
                        : "interrupted",
                  completedAt: now,
                },
              });
              yield* PubSub.publish(events, {
                type: "turn.terminal",
                driver,
                providerTurnId: turn.id,
                providerThreadId: turn.providerThreadId,
                runOrdinal: turn.ordinal,
                ...(scenario === "running"
                  ? {
                      status: "failed",
                      failureItemOrdinal: 999,
                      failure: makeProviderFailure({
                        class: "provider_error",
                        message: "Old stream closed",
                      }),
                    }
                  : { status: scenario === "child" ? "cancelled" : "interrupted", failure: null }),
                threadDisposition: "reusable",
              });
            }),
        };
      }),
  };
  const destination = adapter(target);
  const nativeResumes: boolean[] = [];
  const replacement: typeof destination = {
    ...destination,
    openSession: (input) =>
      destination.openSession(input).pipe(
        Effect.map((session) => ({
          ...session,
          startTurn: (turn) => {
            nativeResumes.push(turn.restartContinuationOfRunId !== undefined);
            return session.startTurn(turn);
          },
        })),
      ),
  };
  const registry = Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
    get: (id) => Effect.succeed(id === old.instanceId ? source : replacement),
    list: () => Effect.succeed([old.instanceId, target.instanceId]),
    getMetadata: () =>
      Effect.succeed({
        driver,
        continuationKey: "fixture-home",
        enabled: true,
        capabilities: caps,
      }),
  });
  const provider: ServerProvider = {
    driver,
    instanceId: target.instanceId,
    displayName: "Work",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: scenario === "signed-out" ? "unauthenticated" : "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...(scenario === "limited" || scenario === "queue"
      ? {
          recentFailure: {
            kind: "usage_limit",
            occurredAt: DateTime.formatIso(yield* DateTime.now),
            resetAt: "2099-01-01T00:00:00.000Z",
            message: "Limit reached",
            modelIds: [scenario === "queue" ? "explicit-other-model" : old.model],
          },
        }
      : {}),
  };
  const settings = ServerSettings.layerTest({
    continueThreadsAfterServerUpdate: false,
    providerInstances: {
      [target.instanceId]: { driver, enabled: true },
    },
    projectSettingsOverrides: {
      [projectId]: {
        providerInstances: { [target.instanceId]: { enabled: scenario !== "disabled" } },
      },
    },
  });
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name: `account-move-${scenario}` },
    registry,
    {
      runEffectWorker: false,
      runContinuationWorker: scenario === "parent" || scenario === "child",
      serverSettingsLayer: settings.pipe(Layer.orDie),
      accountProviders: [provider],
    },
  );
  return {
    layer,
    captured,
    interrupts,
    interruptEntered,
    allowInterrupt,
    completeSourceTurn,
    nativeResumes,
  };
});

const startSource = Effect.fnUntraced(function* (workspace: string, scenario: Scenario) {
  const o = yield* Orchestrator.OrchestratorV2;
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  yield* o.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create"),
    projectId,
    threadId: root,
    title: "Account move",
    modelSelection: old,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: workspace,
    createdBy: "user",
    creationSource: "web",
  });
  const running = yield* watch(
    (e) =>
      e.type === "provider-turn.updated" && e.threadId === root && e.payload.status === "running",
  );
  const preparing = scenario === "preparing" || scenario === "stop-before-start";
  const beforeStart = preparing || scenario === "starting";
  yield* send(root, "original work", old, false, preparing);
  if (!beforeStart) {
    yield* worker.drain();
    yield* Fiber.join(running);
  }
  return { o, worker, beforeStart };
});

const recordAwaitedMonitor = Effect.fnUntraced(function* (
  before: OrchestrationV2ThreadProjection,
  status: "waiting" | "completed",
) {
  // Seed the exact state either side of checkpoint capture, with a native monitor still open.
  const now = yield* DateTime.now;
  const threadId = before.thread.id;
  const run = before.runs[0]!;
  const native = before.providerThreads.find((row) => row.id === run.providerThreadId)!;
  const sink = yield* EventSink.EventSinkV2;
  const attempt = before.attempts[0]!,
    turn = before.providerTurns[0]!;
  yield* sink.write({
    events: [
      {
        id: EventId.make("waiting-turn"),
        threadId,
        occurredAt: now,
        type: "provider-turn.updated",
        payload: { ...turn, status: "completed", completedAt: now },
      },
      {
        id: EventId.make("waiting-attempt"),
        threadId,
        occurredAt: now,
        type: "run-attempt.updated",
        payload: { ...attempt, status: "completed", completedAt: now },
      },
      {
        id: EventId.make("waiting-roster"),
        threadId,
        occurredAt: now,
        type: "provider-thread.updated",
        payload: {
          ...native,
          status: "idle",
          pendingBackgroundTasks: [
            { kind: "monitor", taskId: "test-monitor", description: "watch a build" },
          ],
        },
      },
      {
        id: EventId.make("waiting-run"),
        threadId,
        occurredAt: now,
        type: "run.updated",
        payload: { ...run, status, completedAt: status === "waiting" ? null : now },
      },
    ],
  });
});

it.live.each(unavailableCases)(
  "rejects the destination before interrupting the source · %s",
  (scenario) =>
    Effect.gen(function* () {
      const workspace = yield* checkpointWorkspace(`account-move-${scenario}`);
      const { layer, interrupts } = yield* accountMoveFixture(scenario);
      yield* Effect.gen(function* () {
        const { o } = yield* startSource(workspace, scenario);
        const before = yield* o.getThreadProjection(root);
        const failure = yield* Effect.result(
          o.dispatch({
            type: "thread.model-selection.set",
            commandId: CommandId.make("refused"),
            threadId: root,
            modelSelection: target,
          }),
        );
        assert.equal(failure._tag, "Failure");
        if (failure._tag === "Failure")
          assert.include(
            failure.failure.message,
            {
              limited: "Usage limit",
              disabled: "disabled for project",
              "signed-out": "signed out",
            }[scenario],
          );
        const after = yield* o.getThreadProjection(root);
        assert.deepEqual(after.runs, before.runs);
        assert.deepEqual(after.providerSessions, before.providerSessions);
        assert.deepEqual(after.providerTurns, before.providerTurns);
        assert.deepEqual(after.thread.modelSelection, old);
        assert.isEmpty(interrupts);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.live.each(cases)("moves an account through the replay harness · %s", (scenario) =>
  Effect.gen(function* () {
    const workspace = yield* checkpointWorkspace(`account-move-${scenario}`);
    const {
      layer,
      captured,
      interrupts,
      interruptEntered,
      allowInterrupt,
      completeSourceTurn,
      nativeResumes,
    } = yield* accountMoveFixture(scenario);
    yield* Effect.gen(function* () {
      const { o, worker, beforeStart } = yield* startSource(workspace, scenario);
      let threadId = root;
      let childId: ThreadId | undefined;
      if (scenario === "child" || scenario === "parent") {
        const parentRun = (yield* o.getThreadProjection(root)).runs[0]!;
        const started = yield* watch(
          (e) =>
            e.type === "provider-turn.updated" &&
            e.threadId !== root &&
            e.payload.status === "running",
        );
        yield* o.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make("delegate"),
          parentThreadId: root,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId!,
          task: "review",
          modelSelection: old,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: scenario === "parent" ? "settled_only" : "always",
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* worker.drain();
        yield* Fiber.join(started);
        childId = (yield* o.getThreadProjection(root)).subagents[0]!.childThreadId!;
        if (scenario === "child") {
          threadId = childId;
          const settled = yield* watch(
            (e) =>
              e.type === "run.updated" &&
              e.payload.id === parentRun.id &&
              e.payload.status === "waiting",
          );

          yield* completeSourceTurn.get(root)!;

          yield* Fiber.join(settled);
          yield* worker.drain();
          assert.equal((yield* o.getThreadProjection(root)).runs[0]?.status, "completed");
          // A completed root with only an app-owned child owes no restart prompt.
          const selection = yield* o.dispatch({
            type: "provider.switch",
            commandId: CommandId.make("select-idle-parent"),
            threadId: root,
            modelSelection: target,
          });
          assert.isFalse(
            selection.storedEvents.some(
              (e) =>
                e.event.type === "turn-item.updated" &&
                e.event.payload.type === "run_interrupt_request",
            ),
          );

          // Drain the parent's detach before the child's interrupt is gated.
          yield* worker.drain();
        }
      }
      const before = yield* o.getThreadProjection(threadId);
      const run = before.runs[0]!;
      const native = before.providerThreads.find((p) => p.id === run.providerThreadId)!;
      if (scenario === "waiting" || scenario === "completed-awaiting")
        yield* recordAwaitedMonitor(before, scenario === "waiting" ? "waiting" : "completed");
      const move = (modelSelection: ModelSelection, id: string) =>
        o.dispatch({
          type: scenario === "queue" ? "provider.switch" : "thread.model-selection.set",
          commandId: CommandId.make(id),
          threadId,
          modelSelection,
        });
      if (scenario === "other-model") {
        yield* move({ ...old, model: "other-model" }, "change-model");
        const after = yield* o.getThreadProjection(threadId);
        assert.equal(after.runs[0]?.status, "running");
        assert.equal(after.thread.modelSelection.model, "other-model");
        assert.deepEqual(after.providerSessions, before.providerSessions);
        assert.isEmpty(interrupts);
      }
      const hasQueue = scenario === "queue" || scenario === "preparing" || scenario === "starting";
      if (hasQueue) yield* send(threadId, "queued message", old, true);
      if (scenario === "queue")
        yield* send(
          threadId,
          "explicit selection",
          { ...old, model: "explicit-other-model" },
          true,
        );
      const finished = yield* watch(
        (e) =>
          e.type === "run.updated" &&
          e.threadId === threadId &&
          e.payload.restartContinuationOfRunId === run.id &&
          e.payload.status === (scenario === "late-refusal" ? "failed" : "completed"),
      );
      const queuedFinished = hasQueue
        ? yield* watch(
            (e) =>
              e.type === "run.updated" &&
              e.payload.userMessageId === "queued message" &&
              e.payload.status === "completed",
          )
        : undefined;

      const decision = yield* move(target, "switch-account");
      assert.isTrue(
        decision.storedEvents.some(
          (e) =>
            e.event.type === "turn-item.updated" &&
            e.event.payload.type === "run_interrupt_request",
        ),
      );
      if (hasQueue) {
        const moved = yield* o.getThreadProjection(threadId);
        const queued = moved.runs.find((r) => r.userMessageId === "queued message")!;
        assert.equal(queued.status, "queued");
        assert.equal(queued.providerInstanceId, target.instanceId);
        const attempt = moved.attempts.find((a) => a.id === queued.activeAttemptId)!;
        const node = moved.nodes.find((n) => n.id === queued.rootNodeId)!;
        assert.equal(attempt.providerThreadId, queued.providerThreadId);
        assert.equal(attempt.providerInstanceId, target.instanceId);
        assert.equal(node.providerThreadId, queued.providerThreadId);
        if (node.checkpointScopeId !== null)
          assert.equal(
            moved.checkpointScopes.find((scope) => scope.id === node.checkpointScopeId)
              ?.providerThreadId,
            queued.providerThreadId,
          );
        if (scenario === "queue") {
          const explicit = moved.runs.find((r) => r.userMessageId === "explicit selection")!;
          assert.equal(explicit.providerInstanceId, old.instanceId);
          yield* o.dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make("drop-explicit-queue"),
            threadId,
            runId: explicit.id,
          });
        }
      }
      const interrupt = beforeStart
        ? undefined
        : yield* worker.runOnce.pipe(Effect.forkScoped({ startImmediately: true }));

      if (interrupt) yield* Deferred.await(interruptEntered);
      if (scenario === "child") {
        const parent = yield* o.getThreadProjection(root);
        assert.include(["pending", "running"], parent.subagents[0]!.status);
        assert.isEmpty(parent.messages.filter((m) => m.delegatedCompletion));
      }
      if (scenario === "next-model") yield* move({ ...target, model: "next-model" }, "next-model");
      if (scenario === "stop") {
        yield* o.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("explicit-stop"),
          threadId,
        });
      }
      yield* Deferred.succeed(allowInterrupt, undefined);
      if (interrupt) yield* Fiber.join(interrupt);
      if (scenario === "child") {
        yield* o.recoverDelegatedTasks;
        const parent = yield* o.getThreadProjection(root);
        assert.include(["pending", "running"], parent.subagents[0]!.status);
        assert.isEmpty(parent.messages.filter((m) => m.delegatedCompletion));
      }
      if (scenario === "stop-after-settle") {
        yield* o.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop-settled-source"),
          threadId,
          runId: run.id,
          holdQueue: true,
        });
      }
      if (scenario === "stop" || scenario === "stop-after-settle") {
        yield* worker.drain();
        const after = yield* o.getThreadProjection(threadId);
        assert.deepEqual(
          after.runs.map((r) => r.status),
          ["interrupted"],
        );
        assert.equal(after.thread.providerInstanceId, target.instanceId);
        assert.isEmpty(yield* Ref.get(captured));
        return;
      }
      if (scenario === "preparing" || scenario === "stop-before-start") {
        yield* worker.drain();
        const preparing = (yield* o.getThreadProjection(threadId)).runs.find(
          (r) => r.restartContinuationOfRunId === run.id,
        )!;
        assert.equal(preparing.status, "preparing");
        assert.deepEqual(preparing.workspacePreparation, run.workspacePreparation);
        assert.isEmpty(yield* Ref.get(captured));
        if (scenario === "stop-before-start") {
          yield* o.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("stop-stale-source"),
            threadId,
            runId: run.id,
          });
          yield* worker.drain();
          const stopped = yield* o.getThreadProjection(threadId);
          assert.deepEqual(
            stopped.runs.map((r) => r.status),
            ["interrupted", "interrupted"],
          );
          assert.equal(stopped.thread.providerInstanceId, target.instanceId);
          assert.isEmpty(yield* Ref.get(captured));
          return;
        }
        yield* o.dispatch({
          type: "prepared-run.release",
          commandId: CommandId.make("release-workspace"),
          threadId,
          runId: preparing.id,
        });
      }
      const parentWake =
        childId === undefined
          ? undefined
          : yield* watch(
              (e) =>
                e.type === "message.updated" &&
                e.threadId === root &&
                e.payload.delegatedCompletion !== undefined,
            );
      yield* EffectWorker.runDaemon.pipe(Effect.forkScoped({ startImmediately: true }));

      yield* Fiber.join(finished);
      if (queuedFinished) yield* Fiber.join(queuedFinished);
      const after = yield* o.getThreadProjection(threadId);
      assert.equal(after.runs.find((r) => r.id === run.id)?.status, "interrupted");
      assert.isEmpty(after.turnItems.filter((i) => i.runId === run.id && i.type === "error"));
      const continued = after.runs.find((r) => r.restartContinuationOfRunId === run.id)!;
      assert.equal(continued.providerInstanceId, target.instanceId);
      assert.equal(
        after.messages.find((m) => m.runId === continued.id)?.notification?.summary,
        "Continued on Work",
      );
      if (scenario === "next-model") assert.equal(after.thread.modelSelection.model, "next-model");
      if (scenario === "parent") {
        assert.equal(after.subagents[0]?.completionWake, "always");
        assert.include(["pending", "running"], after.subagents[0]!.status);
        assert.equal((yield* o.getThreadProjection(childId!)).runs[0]?.status, "running");
        const childDone = yield* watch(
          (e) =>
            e.type === "run.updated" && e.threadId === childId && e.payload.status === "completed",
        );

        yield* completeSourceTurn.get(childId!)!;

        yield* Fiber.join(childDone);
      }
      if (parentWake) {
        yield* o.recoverDelegatedTasks;
        yield* Fiber.join(parentWake);
        const parent = yield* o.getThreadProjection(root);
        assert.equal(parent.subagents[0]?.status, "completed");
        assert.lengthOf(
          parent.messages.filter((m) => m.delegatedCompletion),
          1,
        );
      }
      const [first, second] = yield* Ref.get(captured);
      assert.equal(first?.modelSelection.instanceId, target.instanceId);
      assert.isFalse(
        nativeResumes[0],
        "the destination must receive a prompt after an explicit interrupt",
      );
      if (scenario === "running") assert.include(first!.text, "Continue where you left off.");

      if (scenario !== "fallback" && !beforeStart)
        assert.equal(first?.nativeThreadId, native.nativeThreadRef?.nativeId);
      if (beforeStart) assert.include(first!.text, "original work");
      if (scenario === "fallback")
        assert.isTrue(after.contextHandoffs.some((h) => h.targetRunId === continued.id));
      if (scenario === "waiting" || scenario === "completed-awaiting") {
        assert.include(first!.text, "watch a build");
        assert.notInclude(first!.text, "Continue where you left off.");
        assert.isEmpty(
          after.providerThreads.find((row) => row.id === native.id)?.pendingBackgroundTasks ?? [],
        );
      }
      if (hasQueue) {
        assert.equal(second?.text, "queued message");
        assert.equal(second?.modelSelection.instanceId, target.instanceId);
        assert.equal(second?.providerThreadId, first?.providerThreadId);
      }
      if (scenario === "late-refusal") {
        assert.lengthOf(after.runs, 2);
        assert.isTrue(
          after.turnItems.some(
            (i) =>
              i.runId === continued.id && i.type === "error" && i.failure.class === "usage_limit",
          ),
        );
        assert.isUndefined(continued.automaticProviderRetry);
      }
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);
