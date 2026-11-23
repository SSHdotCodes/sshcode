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
  type ServerProvider,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 as caps } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EventSink from "./EventSink.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { makeTestAdapter, type CapturedTurn } from "./testkit/ProviderSwitch.testkit.ts";

// Review tests for account moves. The fixture follows AccountMove.integration.test.ts:
// two accounts of one driver share a continuation key, the source account's turns stay
// running until the test completes or interrupts them.

const driver = ProviderDriverKind.make("codex");
const old = { instanceId: ProviderInstanceId.make("codex"), model: "fixture-model" };
const target = { ...old, instanceId: ProviderInstanceId.make("codex_work") };
const third = { ...old, instanceId: ProviderInstanceId.make("codex_third") };
const projectId = ProjectId.make("account-move-review-project");
const root = ThreadId.make("account-move-review-root");

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

const reviewFixture = Effect.fnUntraced(function* (
  name: string,
  options: {
    readonly secondSwitchBlocker?: "disabled" | "signed-out" | "limited";
    readonly usageProbes?: Ref.Ref<number>;
    readonly databaseLayer?: NonNullable<
      Parameters<typeof ProviderReplayHarness.layerWithRegistry>[2]
    >["databaseLayer"];
    /** Start like a restarted server: reconcile the previous process, then run the worker. */
    readonly restarted?: boolean;
    readonly continueAfterRestart?: boolean;
  } = {},
) {
  const captured = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
  // Turns the source account was asked to run (its runs are not in `captured`).
  const sourceStarts: Array<{
    readonly runId: string;
    readonly text: string;
    readonly prompted: boolean;
    readonly selection: ModelSelection;
  }> = [];
  const completeSourceTurn = new Map<ThreadId, Effect.Effect<void>>();
  const adapter = (modelSelection: ModelSelection) =>
    makeTestAdapter({
      driver,
      instanceId: modelSelection.instanceId,
      capabilities: caps,
      modelSelection,
      capturedTurns: captured,
      responseByRunOrdinal: {},
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
              sourceStarts.push({
                runId: input.runId,
                text: input.message.text,
                selection: input.modelSelection,
                prompted: input.restartContinuationOfRunId === undefined,
              });
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
                  const completed = { ...turn, status: "completed" as const, completedAt: now };
                  turns.set(turn.id, completed);
                  yield* PubSub.publish(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: completed,
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
              const turn = turns.get(input.providerTurnId);
              // A turn that already finished has nothing left to interrupt.
              if (!turn || turn.status !== "running") return;
              const now = yield* DateTime.now;
              const interrupted = { ...turn, status: "interrupted" as const, completedAt: now };
              turns.set(turn.id, interrupted);
              yield* PubSub.publish(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: interrupted,
              });
              yield* PubSub.publish(events, {
                type: "turn.terminal",
                driver,
                providerTurnId: turn.id,
                providerThreadId: turn.providerThreadId,
                runOrdinal: turn.ordinal,
                status: "interrupted",
                failure: null,
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
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  const providers: ServerProvider[] = [
    provider,
    { ...provider, instanceId: old.instanceId, displayName: old.instanceId },
    {
      ...provider,
      instanceId: third.instanceId,
      displayName: "Third",
      ...(options.secondSwitchBlocker === "signed-out"
        ? { auth: { status: "unauthenticated" } }
        : {}),
      ...(options.secondSwitchBlocker === "limited"
        ? {
            usageLimits: {
              checkedAt: provider.checkedAt,
              windows: [{ id: "weekly", label: "Weekly", kind: "weekly", usedPercent: 100 }],
            },
          }
        : {}),
    },
  ];
  const settings = ServerSettings.layerTest({
    continueThreadsAfterServerUpdate: options.continueAfterRestart ?? false,
    providerInstances: {
      [target.instanceId]: { driver, enabled: true },
      [third.instanceId]: { driver, enabled: true },
    },
    projectSettingsOverrides: {
      [projectId]: {
        providerInstances: {
          [third.instanceId]: { enabled: options.secondSwitchBlocker !== "disabled" },
        },
      },
    },
  });
  const probes = options.usageProbes;
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name: `account-move-review-${name}` },
    registry,
    {
      runEffectWorker: options.restarted === true,
      recoverOnStartup: options.restarted === true,
      ...(options.databaseLayer === undefined ? {} : { databaseLayer: options.databaseLayer }),
      serverSettingsLayer: settings.pipe(Layer.orDie),
      accountProviders: providers,
      ...(probes === undefined
        ? {}
        : {
            getProvidersForUsageLimits: () =>
              Ref.update(probes, (count) => count + 1).pipe(Effect.as(providers)),
          }),
    },
  );
  return { layer, captured, sourceStarts, completeSourceTurn, nativeResumes };
});

const startSource = Effect.fnUntraced(function* (workspace: string) {
  const o = yield* Orchestrator.OrchestratorV2;
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  yield* o.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create"),
    projectId,
    threadId: root,
    title: "Account move review",
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
  yield* o.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("original work"),
    threadId: root,
    text: "original work",
    messageId: MessageId.make("original work"),
    attachments: [],
    modelSelection: old,
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  yield* worker.drain();
  yield* Fiber.join(running);
  const run = (yield* o.getThreadProjection(root)).runs[0]!;
  return { o, worker, run };
});

const select = (modelSelection: ModelSelection, id: string) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (o) =>
    o.dispatch({
      type: "thread.model-selection.set",
      commandId: CommandId.make(id),
      threadId: root,
      modelSelection,
    }),
  );

const finishSourceTurn = Effect.fnUntraced(function* (
  completeSourceTurn: Map<ThreadId, Effect.Effect<void>>,
  runId: string,
) {
  const waiting = yield* watch(
    (e) => e.type === "run.updated" && e.payload.id === runId && e.payload.status === "waiting",
  );
  yield* completeSourceTurn.get(root)!;
  yield* Fiber.join(waiting);
});

const queueMessage = (text: string, modelSelection = old) =>
  Orchestrator.OrchestratorV2.use((o) =>
    o.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(text),
      threadId: root,
      text,
      messageId: MessageId.make(text),
      attachments: [],
      modelSelection,
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    }),
  );

it.live.each(["already queued", "sent after completion"])(
  "a completed source releases its queue while the move is still pending · %s",
  (timing) =>
    Effect.gen(function* () {
      const workspace = yield* checkpointWorkspace("account-move-review-queue-completion");
      const fixture = yield* reviewFixture("queue-completion");
      yield* Effect.gen(function* () {
        const { o, run } = yield* startSource(workspace);
        if (timing === "already queued") yield* queueMessage("next queued turn");
        yield* select(target, "switch-account");
        yield* finishSourceTurn(fixture.completeSourceTurn, run.id);
        const waiting = (yield* o.getThreadProjection(root)).runs.find((r) => r.id === run.id)!;
        const admitted = yield* watch(
          (e) =>
            (e.type === "run.updated" || e.type === "run.created") &&
            e.payload.userMessageId === "next queued turn" &&
            e.payload.status === "starting",
        );
        // Reproduce the checkpoint winning the race without draining the pending move.
        const now = yield* DateTime.now;
        const sink = yield* EventSink.EventSinkV2;
        yield* sink.write({
          events: [
            {
              id: EventId.make("source-checkpoint-complete"),
              threadId: root,
              runId: run.id,
              occurredAt: now,
              type: "run.updated",
              payload: { ...waiting, status: "completed", completedAt: now },
            },
          ],
        });
        if (timing === "sent after completion") {
          const sent = yield* queueMessage("next queued turn", target);
          assert.isTrue(
            sent.storedEvents.some(
              ({ event }) => event.type === "run.created" && event.payload.status === "starting",
            ),
            "the new message should start without waiting for the obsolete interrupt",
          );
        }
        yield* Fiber.join(admitted).pipe(Effect.timeout("10 seconds"));
        const done = yield* watch(
          (e) =>
            e.type === "run.updated" &&
            e.payload.userMessageId === "next queued turn" &&
            e.payload.status === "completed",
        );
        yield* EffectWorker.runDaemon.pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Fiber.join(done).pipe(Effect.timeout("15 seconds"));
        const after = yield* o.getThreadProjection(root);
        assert.deepEqual(
          after.runs.map((r) => r.status),
          ["completed", "completed"],
        );
        assert.deepEqual(
          (yield* Ref.get(fixture.captured)).map((turn) => turn.text),
          ["next queued turn"],
        );
      }).pipe(Effect.provide(fixture.layer));
    }).pipe(Effect.scoped),
);

it.live(
  "a turn that finishes before the move's interrupt reaches it stays completed and is not continued",
  () =>
    Effect.gen(function* () {
      const workspace = yield* checkpointWorkspace("account-move-review-finish-race");
      const { layer, captured, completeSourceTurn } = yield* reviewFixture("finish-race");
      yield* Effect.gen(function* () {
        const { o, worker, run } = yield* startSource(workspace);
        // The move commits while the turn runs; its interrupt is still in the outbox.
        yield* select(target, "switch-account");
        // The provider finishes the turn before it receives the interrupt.
        yield* finishSourceTurn(completeSourceTurn, run.id);
        yield* worker.drain();
        const after = yield* o.getThreadProjection(root);
        assert.deepEqual(
          {
            runs: after.runs.map((r) => ({
              continues: r.restartContinuationOfRunId ?? null,
              status: r.status,
            })),
            sentToNewAccount: (yield* Ref.get(captured)).map((turn) => turn.text),
          },
          { runs: [{ continues: null, status: "completed" }], sentToNewAccount: [] },
          "work that already finished must keep its outcome and get no continuation turn",
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.live("a selection change while a finished turn is still finalizing does not interrupt it", () =>
  Effect.gen(function* () {
    const workspace = yield* checkpointWorkspace("account-move-review-finalizing");
    const { layer, captured, completeSourceTurn } = yield* reviewFixture("finalizing");
    yield* Effect.gen(function* () {
      const { o, worker, run } = yield* startSource(workspace);
      // The turn is over; only its checkpoint capture is still pending ("waiting").
      yield* finishSourceTurn(completeSourceTurn, run.id);
      const decision = yield* select(target, "switch-after-finish");
      yield* worker.drain();
      const after = yield* o.getThreadProjection(root);
      assert.deepEqual(
        {
          interrupted: decision.storedEvents.some(
            (e) =>
              e.event.type === "turn-item.updated" &&
              e.event.payload.type === "run_interrupt_request",
          ),
          runs: after.runs.map((r) => r.status),
          sentToNewAccount: (yield* Ref.get(captured)).map((turn) => turn.text),
        },
        { interrupted: false, runs: ["completed"], sentToNewAccount: [] },
        "a turn that already finished must not be interrupted or continued by an account change",
      );
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.live.each([
  { name: "back to the first account", final: old },
  { name: "another model on the new account", final: { ...target, model: "next-model" } },
])(
  "a selection change made while a move is in flight decides where the turn continues · $name",
  ({ name, final }) =>
    Effect.gen(function* () {
      const workspace = yield* checkpointWorkspace(`account-move-review-${name}`);
      const { layer, captured, sourceStarts } = yield* reviewFixture(name);
      yield* Effect.gen(function* () {
        const { o, worker, run } = yield* startSource(workspace);
        yield* select(target, "switch-account");
        // The user changes their mind before the move's interrupt has run.
        yield* select(final, "change-mind");
        yield* worker.drain();
        const after = yield* o.getThreadProjection(root);
        assert.deepEqual(after.thread.modelSelection, final);
        const later = after.runs.filter((r) => r.id !== run.id);
        assert.lengthOf(later, 1);
        if (final.instanceId === old.instanceId) {
          const resumed = sourceStarts.find((start) => start.runId === later[0]?.id);
          assert.equal(resumed?.prompted, true);
          assert.include(resumed!.text, "Continue where you left off.");
          assert.equal(
            after.messages.find((m) => m.runId === later[0]?.id)?.notification?.summary,
            `Continued on ${old.instanceId}`,
          );
        }
        assert.deepEqual(
          {
            runs: later.map((r) => r.modelSelection),
            sent: [
              ...(yield* Ref.get(captured)).map((turn) => turn.modelSelection),
              ...sourceStarts.filter((turn) => turn.runId !== run.id).map((turn) => turn.selection),
            ],
          },
          { runs: later.map(() => final), sent: later.map(() => final) },
          "work started after the move must use the selection the thread ended up with",
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.live.each(["disabled", "signed-out", "limited"] as const)(
  "a pending move rejects a %s replacement destination",
  (blocker) =>
    Effect.gen(function* () {
      const workspace = yield* checkpointWorkspace("pending-blocked-" + blocker);
      const fixture = yield* reviewFixture("pending-blocked-" + blocker, {
        secondSwitchBlocker: blocker,
      });
      yield* Effect.gen(function* () {
        const { o, worker, run } = yield* startSource(workspace);
        yield* select(target, "switch-account");
        const result = yield* Effect.result(select(third, "switch-again"));
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure")
          assert.include(
            result.failure.message,
            {
              disabled: "disabled for project",
              "signed-out": "signed out",
              limited: "Usage limit",
            }[blocker],
          );
        assert.deepEqual((yield* o.getThreadProjection(root)).thread.modelSelection, target);
        yield* worker.drain();
        const continued = (yield* o.getThreadProjection(root)).runs.find(
          (r) => r.restartContinuationOfRunId === run.id,
        );
        assert.deepEqual(continued?.modelSelection, target);
      }).pipe(Effect.provide(fixture.layer));
    }).pipe(Effect.scoped),
);

it.live("the continuation and its queued message both use the latest account and model", () =>
  Effect.gen(function* () {
    const workspace = yield* checkpointWorkspace("account-move-review-retarget-queue");
    const fixture = yield* reviewFixture("retarget-queue");
    yield* Effect.gen(function* () {
      const { o, worker, run } = yield* startSource(workspace);
      yield* queueMessage("follow the move");
      yield* select(target, "switch-account");
      // Land the second selection in the interval after acknowledgement and before admission.
      assert.isTrue(yield* worker.runOnce);
      yield* select(old, "back-to-source");
      const model = { ...target, model: "latest-model" };
      yield* select(model, "select-model");
      const final = { ...model, options: [{ id: "fastMode", value: true }] };
      yield* select(final, "select-final");
      const done = yield* watch(
        (e) =>
          e.type === "run.updated" &&
          e.payload.userMessageId === "follow the move" &&
          e.payload.status === "completed",
      );
      yield* EffectWorker.runDaemon.pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Fiber.join(done).pipe(Effect.timeout("15 seconds"));
      const after = yield* o.getThreadProjection(root);
      const continued = after.runs.find((r) => r.restartContinuationOfRunId === run.id)!;
      const queued = after.runs.find((r) => r.userMessageId === "follow the move")!;
      assert.deepEqual(after.thread.modelSelection, final);
      assert.deepEqual(continued.modelSelection, final);
      assert.deepEqual(queued.modelSelection, final);
      assert.equal(queued.providerThreadId, continued.providerThreadId);
      assert.deepEqual(
        (yield* Ref.get(fixture.captured)).map((turn) => turn.modelSelection),
        [final, final],
      );
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.scoped),
);

it.live("switching the account of an idle chat does not wait on a usage-limit refresh", () =>
  Effect.gen(function* () {
    const workspace = yield* checkpointWorkspace("account-move-review-idle-probe");
    const usageProbes = yield* Ref.make(0);
    const { layer, completeSourceTurn } = yield* reviewFixture("idle-probe", { usageProbes });
    yield* Effect.gen(function* () {
      const { o, worker, run } = yield* startSource(workspace);
      yield* finishSourceTurn(completeSourceTurn, run.id);
      yield* worker.drain();
      assert.deepEqual(
        (yield* o.getThreadProjection(root)).runs.map((r) => r.status),
        ["completed"],
      );
      // getProvidersForUsageLimits can block for up to three seconds on a stale reading,
      // inside this thread's command. Nothing is moved here, so nothing needs it.
      yield* select(target, "idle-switch");
      assert.equal(yield* Ref.get(usageProbes), 0);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.live.each([true, false])(
  "a restart after the move's continuation is admitted still prompts the new account · automatic recovery %s",
  (continueAfterRestart) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* Effect.acquireRelease(
        fs.makeTempDirectory({ prefix: "t3-account-move-review-restart-" }),
        (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
      );
      const databaseLayer = SqlitePersistence.layerFromPath(`${dir}/state.sqlite`).pipe(
        Layer.provide(NodeServices.layer),
      );
      const workspace = yield* checkpointWorkspace("account-move-review-restart");
      // The first process: the move interrupts the turn and admits its continuation,
      // then the server stops before the continuation reaches the new account.
      const first = yield* reviewFixture("restart-first", { databaseLayer });
      const continuation = yield* Effect.gen(function* () {
        const { o, worker, run } = yield* startSource(workspace);
        yield* select(target, "switch-account");
        assert.isTrue(yield* worker.runOnce, "the move's interrupt");
        assert.isTrue(yield* worker.runOnce, "the move's continuation");
        const admitted = (yield* o.getThreadProjection(root)).runs.find(
          (r) => r.restartContinuationOfRunId === run.id,
        );
        assert.equal(admitted?.status, "starting");
        assert.isEmpty(yield* Ref.get(first.captured));
        return admitted!;
      }).pipe(Effect.provide(first.layer), Effect.scoped);
      // A fresh runtime opens the same database and reconciles before starting its worker.
      const second = yield* reviewFixture("restart-second", {
        databaseLayer,
        restarted: true,
        continueAfterRestart,
      });
      yield* Effect.gen(function* () {
        const o = yield* Orchestrator.OrchestratorV2;
        const started = yield* watch(
          (e) =>
            e.type === "run.updated" &&
            e.payload.restartContinuationOfRunId === continuation.id &&
            e.payload.status === "completed",
        );
        const already = (yield* o.getThreadProjection(root)).runs.some(
          (r) => r.restartContinuationOfRunId === continuation.id && r.status === "completed",
        );
        if (!already) yield* Fiber.join(started).pipe(Effect.timeout("20 seconds"));
        const after = yield* o.getThreadProjection(root);
        assert.deepEqual(
          after.runs.map((r) => [r.providerInstanceId, r.status]),
          [
            [old.instanceId, "interrupted"],
            [target.instanceId, "cancelled"],
            [target.instanceId, "completed"],
          ],
        );
        assert.deepEqual(
          (yield* Ref.get(second.captured)).map((turn) => turn.text),
          ["Continue where you left off."],
        );
        assert.deepEqual(
          second.nativeResumes,
          [false],
          "the destination must receive a prompt after an explicit interrupt",
        );
      }).pipe(Effect.provide(second.layer), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
