import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { makeTestAdapter, type CapturedTurn } from "./testkit/ProviderSwitch.testkit.ts";

// Round 2 review: a person's selection change on an idle chat and the runs queued under
// the selection it replaced. Two Codex accounts share native history; Claude does not.

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");
const old: ModelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "x-model" };
const work: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex_work"),
  model: "x-model",
};
const other: ModelSelection = { instanceId: ProviderInstanceId.make("claude"), model: "c-model" };
const root = ThreadId.make("account-move-review2-root");

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

const fixture = Effect.fnUntraced(function* (name: string, limited = true, runEffectWorker = true) {
  const captured = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
  const firstTurnStarted = yield* Deferred.make<void>();
  const releaseFirstTurn = yield* Deferred.make<void>();
  const adapters = [
    makeTestAdapter({
      driver: codex,
      instanceId: old.instanceId,
      capabilities: CodexProviderCapabilitiesV2,
      modelSelection: old,
      capturedTurns: captured,
      responseByRunOrdinal: {},
      // The first turn hits the account's usage limit once the wake is queued behind it.
      ...(limited ? { limitedRunOrdinals: new Set([1]) } : {}),
      holdFirstTurn: firstTurnStarted,
      releaseFirstTurn,
    }),
    makeTestAdapter({
      driver: codex,
      instanceId: work.instanceId,
      capabilities: CodexProviderCapabilitiesV2,
      modelSelection: work,
      capturedTurns: captured,
      responseByRunOrdinal: {},
    }),
    makeTestAdapter({
      driver: claude,
      instanceId: other.instanceId,
      capabilities: ClaudeProviderCapabilitiesV2,
      modelSelection: other,
      capturedTurns: captured,
      responseByRunOrdinal: {},
    }),
  ];
  const find = (instanceId: ProviderInstanceId) =>
    adapters.find((adapter) => adapter.instanceId === instanceId);
  const registry = Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
    get: (instanceId) => {
      const adapter = find(instanceId);
      return adapter === undefined
        ? Effect.fail(
            new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
          )
        : Effect.succeed(adapter);
    },
    list: () => Effect.succeed(adapters.map((adapter) => adapter.instanceId)),
    getMetadata: (instanceId) => {
      const adapter = find(instanceId);
      return adapter === undefined
        ? Effect.fail(
            new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
          )
        : Effect.succeed({
            driver: adapter.driver,
            continuationKey: adapter.driver === codex ? "codex-home" : "claude-home",
            enabled: true,
            capabilities:
              adapter.driver === codex ? CodexProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2,
          });
    },
  });
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name: `account-move-review2-${name}` },
    registry,
    { runEffectWorker },
  );
  return { layer, captured, firstTurnStarted, releaseFirstTurn };
});

const send = (
  text: string,
  dispatchMode: "start_immediately" | "queue_after_active",
  modelSelection?: ModelSelection,
) =>
  Orchestrator.OrchestratorV2.use((o) =>
    o.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${text}`),
      threadId: root,
      text,
      messageId: MessageId.make(text),
      attachments: [],
      ...(modelSelection === undefined ? {} : { modelSelection }),
      dispatchMode: { type: dispatchMode },
      createdBy: "user",
      creationSource: "web",
    }),
  );

// A monitor's completion arrives as a server wake queued behind the running turn.
const queueWake = Orchestrator.OrchestratorV2.use((o) =>
  o.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("monitor-wake"),
    threadId: root,
    text: "Build watcher finished",
    messageId: MessageId.make("monitor-wake"),
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    notification: {
      source: { kind: "monitor" },
      outcome: "completed",
      summary: "Build watcher: exited with code 0",
      detail: "Build watcher finished",
    },
    createdBy: "agent",
    creationSource: "server",
  }),
);

/** Runs a turn on `old` into its usage limit with `queue` waiting behind it, then returns. */
const limitedTurnWithQueue = Effect.fnUntraced(function* (
  setup: Effect.Success<ReturnType<typeof fixture>>,
  workspace: string,
  queue: Effect.Effect<unknown, Orchestrator.OrchestratorV2Error, Orchestrator.OrchestratorV2>,
) {
  const o = yield* Orchestrator.OrchestratorV2;
  yield* o.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create"),
    projectId: ProjectId.make("account-move-review2-project"),
    threadId: root,
    title: "Idle selection change",
    modelSelection: old,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: workspace,
    createdBy: "user",
    creationSource: "web",
  });
  const failed = yield* watch(
    (e) => e.type === "run.updated" && e.payload.ordinal === 1 && e.payload.status === "failed",
  );
  yield* send("original work", "start_immediately", old);
  yield* Deferred.await(setup.firstTurnStarted);
  yield* queue;
  yield* Deferred.succeed(setup.releaseFirstTurn, undefined);
  yield* Fiber.join(failed).pipe(Effect.timeout("30 seconds"));
  const limited = yield* o.getThreadProjection(root);
  assert.deepEqual(
    limited.runs.map((run) => run.status),
    ["failed", "queued"],
    "the usage limit holds the queued run",
  );
  return o;
});

it.live.each([
  { name: "another model on the same account", final: { ...old, model: "y-model" } },
  { name: "another account of the same driver", final: work },
  { name: "another account and model", final: { ...work, model: "y-model" } },
  { name: "another driver", final: other },
])(
  "a run queued before an idle selection change runs on the new selection · $name",
  ({ name, final }) =>
    Effect.gen(function* () {
      const workspace = yield* checkpointWorkspace(`account-move-review2-${name}`);
      const setup = yield* fixture(name);
      yield* Effect.gen(function* () {
        const o = yield* limitedTurnWithQueue(setup, workspace, queueWake);
        // Nothing runs: the person picks another selection and continues by hand.
        yield* o.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make("pick"),
          threadId: root,
          modelSelection: final,
        });
        const wakeDone = yield* watch(
          (e) =>
            e.type === "run.updated" &&
            e.payload.userMessageId === "monitor-wake" &&
            (e.payload.status === "completed" || e.payload.status === "failed"),
        );
        yield* send("Continue.", "start_immediately", final);
        yield* Fiber.join(wakeDone).pipe(Effect.timeout("30 seconds"));
        const after = yield* o.getThreadProjection(root);
        const wake = after.runs.find((run) => run.userMessageId === "monitor-wake")!;
        assert.deepEqual(
          {
            thread: after.thread.modelSelection,
            wake: [wake.modelSelection, wake.status],
            // A portable handoff prefixes the provider input; the person's text ends it.
            sent: (yield* Ref.get(setup.captured)).map((turn) => [
              turn.text.split("User message:\n").at(-1),
              turn.modelSelection,
            ]),
          },
          {
            thread: final,
            wake: [final, "completed"],
            sent: [
              ["original work", old],
              ["Continue.", final],
              ["Build watcher finished", final],
            ],
          },
          "the queue must follow the person's selection and never switch the chat back",
        );
      }).pipe(Effect.provide(setup.layer));
    }).pipe(Effect.scoped),
);

it.live("a message queued with its own model keeps it across an idle selection change", () =>
  Effect.gen(function* () {
    const workspace = yield* checkpointWorkspace("account-move-review2-explicit");
    const setup = yield* fixture("explicit");
    const own = { ...old, model: "own-model" };
    yield* Effect.gen(function* () {
      const o = yield* limitedTurnWithQueue(
        setup,
        workspace,
        send("my own model", "queue_after_active", own),
      );
      yield* o.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("pick"),
        threadId: root,
        modelSelection: work,
      });
      const queuedAfter = (yield* o.getThreadProjection(root)).runs.find(
        (run) => run.userMessageId === "my own model",
      );
      assert.deepEqual(queuedAfter?.modelSelection, own);
    }).pipe(Effect.provide(setup.layer));
  }).pipe(Effect.scoped),
);

it.live.each([
  { name: "another model on the same account", final: { ...old, model: "y-model" } },
  { name: "another driver", final: other },
])(
  "a run queued behind a turn follows a selection change that does not move the turn · $name",
  ({ name, final }) =>
    Effect.gen(function* () {
      const workspace = yield* checkpointWorkspace(`account-move-review2-running-${name}`);
      const setup = yield* fixture(`running-${name}`, false);
      yield* Effect.gen(function* () {
        const o = yield* Orchestrator.OrchestratorV2;
        yield* o.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          projectId: ProjectId.make("account-move-review2-project"),
          threadId: root,
          title: "Selection change during a turn",
          modelSelection: old,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: workspace,
          createdBy: "user",
          creationSource: "web",
        });
        yield* send("original work", "start_immediately", old);
        yield* Deferred.await(setup.firstTurnStarted);
        yield* send("next step", "queue_after_active", old);
        // The turn keeps running where it is; the new selection starts with the next turn.
        yield* o.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make("pick"),
          threadId: root,
          modelSelection: final,
        });
        const done = yield* watch(
          (e) =>
            e.type === "run.updated" &&
            e.payload.userMessageId === "next step" &&
            (e.payload.status === "completed" || e.payload.status === "failed"),
        );
        yield* Deferred.succeed(setup.releaseFirstTurn, undefined);
        yield* Fiber.join(done).pipe(Effect.timeout("30 seconds"));
        const after = yield* o.getThreadProjection(root);
        assert.deepEqual(
          {
            thread: after.thread.modelSelection,
            runs: after.runs.map((run) => [run.modelSelection, run.status]),
            sent: (yield* Ref.get(setup.captured)).map((turn) => [
              turn.text.split("User message:\n").at(-1),
              turn.modelSelection,
            ]),
          },
          {
            thread: final,
            runs: [
              [old, "completed"],
              [final, "completed"],
            ],
            sent: [
              ["original work", old],
              ["next step", final],
            ],
          },
          "the queued turn must use the selection the person ended up with",
        );
      }).pipe(Effect.provide(setup.layer));
    }).pipe(Effect.scoped),
);

it.live.each([
  { name: "model", final: { ...old, model: "y-model" } },
  { name: "provider", final: other },
])("sends a retargeted startup steer as its own turn on the new $name", ({ name, final }) =>
  Effect.gen(function* () {
    const workspace = yield* checkpointWorkspace("account-move-starting-" + name);
    const setup = yield* fixture("starting-" + name, false, false);
    yield* Effect.gen(function* () {
      const o = yield* Orchestrator.OrchestratorV2;
      yield* o.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        projectId: ProjectId.make("account-move-review2-project"),
        threadId: root,
        title: "Starting turn",
        modelSelection: old,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: workspace,
        createdBy: "user",
        creationSource: "web",
      });
      yield* send("original work", "start_immediately", old);
      yield* o.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("follow"),
        threadId: root,
        text: "next step",
        messageId: MessageId.make("follow"),
        attachments: [],
        deliveryIntent: "steer",
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const [starting, follow] = (yield* o.getThreadProjection(root)).runs;
      assert.equal(starting?.status, "starting");
      assert.equal(follow?.steerWhenLiveRunId, starting!.id);
      yield* o.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("pick"),
        threadId: root,
        modelSelection: final,
      });
      const rebound = (yield* o.getThreadProjection(root)).runs[1]!;
      assert.deepEqual(rebound.modelSelection, final);
      assert.isUndefined(rebound.steerWhenLiveRunId);
      yield* Deferred.succeed(setup.releaseFirstTurn, undefined);
      const done = yield* watch(
        (e) =>
          e.type === "run.updated" &&
          e.payload.id === rebound.id &&
          e.payload.status === "completed",
      );
      yield* EffectWorker.runDaemon.pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Fiber.join(done).pipe(Effect.timeout("15 seconds"));
      assert.deepEqual(
        (yield* Ref.get(setup.captured)).map((turn) => turn.modelSelection),
        [old, final],
      );
    }).pipe(Effect.provide(setup.layer));
  }).pipe(Effect.scoped),
);
