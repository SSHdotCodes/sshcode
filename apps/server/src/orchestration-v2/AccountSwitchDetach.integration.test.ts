import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EventSink from "./EventSink.ts";

it.effect(
  "a compatible Codex account switch unloads the old native thread from its pooled process",
  () => {
    const oldAccount = ProviderInstanceId.make("codex");
    const newAccount = ProviderInstanceId.make("codex_work");
    const driver = ProviderDriverKind.make("codex");
    const sourceSession = ProviderSessionId.make("account-old-codex-pool");
    const threadId = ThreadId.make("account-moving-chat");
    const otherThread = ThreadId.make("account-chat-staying-on-old-account");
    const projectId = ProjectId.make("account-account-switch");
    const selection = { instanceId: oldAccount, model: "gpt-6.1-sol" };
    const policy = {
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      cwd: null,
    };
    const unloaded: string[] = [];
    const adapterFor = (instanceId: typeof oldAccount) =>
      ProviderAdapter.ProviderAdapterV2.of({
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
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
                providerInstanceId: instanceId,
                driver,
                status: "ready",
                cwd: process.cwd(),
                model: selection.model,
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.never,
              ensureThread: () => Effect.die("unused"),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              startTurn: () => Effect.die("no provider execution in this test"),
              steerTurn: () => Effect.void,
              interruptTurn: () => Effect.void,
              unloadThread: ({ providerThread }) =>
                Effect.sync(() => {
                  unloaded.push(providerThread.nativeThreadRef!.nativeId!);
                }),
              respondToRuntimeRequest: () => Effect.void,
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
          }),
      });
    const adapters = [adapterFor(oldAccount), adapterFor(newAccount)];
    const registry = Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
      get: (instanceId) =>
        Effect.succeed(adapters.find((adapter) => adapter.instanceId === instanceId)!),
      list: () => Effect.succeed([oldAccount, newAccount]),
      getMetadata: () =>
        Effect.succeed({
          driver,
          continuationKey: "codex:home:/synthetic/shared",
          enabled: true,
          capabilities: CodexProviderCapabilitiesV2,
        }),
    });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const sink = yield* EventSink.EventSinkV2;
      for (const id of [threadId, otherThread])
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${id}`),
          threadId: id,
          projectId,
          title: "Account switch thread",
          modelSelection: selection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
      const runtime = yield* manager.open({
        threadId,
        providerSessionId: sourceSession,
        modelSelection: selection,
        runtimePolicy: policy,
      });
      yield* manager.open({
        threadId: otherThread,
        providerSessionId: sourceSession,
        modelSelection: selection,
        runtimePolicy: policy,
      });
      const now = yield* DateTime.now;
      const native: OrchestrationV2ProviderThread = {
        id: ProviderThreadId.make("account-shared-native-row"),
        driver,
        providerInstanceId: oldAccount,
        providerSessionId: sourceSession,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: "account-native-chat", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("seed-native-row"),
            type: "provider-thread.updated",
            threadId,
            providerInstanceId: oldAccount,
            occurredAt: now,
            payload: native,
          },
        ],
      });
      yield* runtime.resumeThread({
        providerThread: native,
        threadId,
        modelSelection: selection,
        runtimePolicy: policy,
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).thread.activeProviderThreadId,
        native.id,
      );
      // A send with an exact account choice is a supported switch path. The worker
      // is disabled; inspect and execute just the old-session detach it commits.
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("switch-on-next-send"),
        threadId,
        messageId: MessageId.make("switch-on-next-send"),
        text: "synthetic next turn",
        attachments: [],
        modelSelection: { ...selection, instanceId: newAccount },
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const switched = yield* orchestrator.getThreadProjection(threadId);
      const moved = switched.providerThreads.find((thread) => thread.id === native.id)!;
      assert.equal(moved.providerInstanceId, newAccount);
      assert.notEqual(moved.providerSessionId, sourceSession);
      assert.deepEqual(moved.nativeThreadRef, native.nativeThreadRef);
      yield* manager.detach({ providerSessionId: sourceSession, threadId });
      assert.isTrue(Option.isSome(yield* manager.get(sourceSession))); // Other chat keeps the process live.
      assert.deepEqual(unloaded, ["account-native-chat"]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          { name: "account-account-switch-detach" },
          registry,
          { runEffectWorker: false },
        ),
      ),
    );
  },
);

it.effect("switching outside the continuation group leaves a running turn attached", () => {
  const oldAccount = ProviderInstanceId.make("codex");
  const newAccount = ProviderInstanceId.make("codex_work");
  const driver = ProviderDriverKind.make("codex");
  const sourceSession = ProviderSessionId.make("account-running-codex-pool");
  const idleThread = ThreadId.make("account-idle-chat");
  const runningThread = ThreadId.make("account-running-chat");
  const projectId = ProjectId.make("account-switch-mid-turn");
  const selection = { instanceId: oldAccount, model: "gpt-6.1-sol" };
  const policy = {
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    cwd: null,
  };
  const adapterFor = (instanceId: typeof oldAccount) =>
    ProviderAdapter.ProviderAdapterV2.of({
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
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
              providerInstanceId: instanceId,
              driver,
              status: "ready",
              cwd: process.cwd(),
              model: selection.model,
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
            events: Stream.never,
            ensureThread: () => Effect.die("unused"),
            resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
            startTurn: () => Effect.die("no provider execution in this test"),
            steerTurn: () => Effect.void,
            interruptTurn: () => Effect.void,
            unloadThread: () => Effect.void,
            respondToRuntimeRequest: () => Effect.void,
            readThreadSnapshot: () => Effect.die("unused"),
            rollbackThread: () => Effect.die("unused"),
            forkThread: () => Effect.die("unused"),
          } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
        }),
    });
  const adapters = [adapterFor(oldAccount), adapterFor(newAccount)];
  const registry = Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
    get: (instanceId) =>
      Effect.succeed(adapters.find((adapter) => adapter.instanceId === instanceId)!),
    list: () => Effect.succeed([oldAccount, newAccount]),
    getMetadata: (instanceId) =>
      Effect.succeed({
        driver,
        continuationKey: `codex:home:/synthetic/${instanceId}`,
        enabled: true,
        capabilities: CodexProviderCapabilitiesV2,
      }),
  });
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    for (const id of [idleThread, runningThread]) {
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${id}`),
        threadId: id,
        projectId,
        title: "Account switch thread",
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const runtime = yield* manager.open({
        threadId: id,
        providerSessionId: sourceSession,
        modelSelection: selection,
        runtimePolicy: policy,
      });
      const native: OrchestrationV2ProviderThread = {
        id: ProviderThreadId.make(`native-row:${id}`),
        driver,
        providerInstanceId: oldAccount,
        providerSessionId: sourceSession,
        appThreadId: id,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: `native:${id}`, strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make(`seed-native-row:${id}`),
            type: "provider-thread.updated",
            threadId: id,
            providerInstanceId: oldAccount,
            occurredAt: now,
            payload: native,
          },
        ],
      });
      yield* runtime.resumeThread({
        providerThread: native,
        threadId: id,
        modelSelection: selection,
        runtimePolicy: policy,
      });
    }
    // The effect worker is off, so this turn stays in flight on the old account.
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("running-turn"),
      threadId: runningThread,
      messageId: MessageId.make("running-turn"),
      text: "synthetic long turn",
      attachments: [],
      modelSelection: selection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const sessionsOf = (id: typeof idleThread) =>
      orchestrator
        .getThreadProjection(id)
        .pipe(Effect.map((projection) => projection.providerSessions.map((session) => session.id)));
    assert.include(yield* sessionsOf(idleThread), sourceSession);
    assert.include(yield* sessionsOf(runningThread), sourceSession);
    for (const id of [idleThread, runningThread])
      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make(`use-other-account:${id}`),
        threadId: id,
        modelSelection: { ...selection, instanceId: newAccount },
      });
    // Both chats are on the new account for their next turn.
    for (const id of [idleThread, runningThread])
      assert.equal(
        (yield* orchestrator.getThreadProjection(id)).thread.providerInstanceId,
        newAccount,
      );
    // Only the idle chat let go of the old account's session.
    assert.notInclude(yield* sessionsOf(idleThread), sourceSession);
    assert.include(yield* sessionsOf(runningThread), sourceSession);
    const running = (yield* orchestrator.getThreadProjection(runningThread)).runs[0]!;
    assert.include(["preparing", "starting", "running"], running.status);
    assert.equal(running.providerInstanceId, oldAccount);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ProviderReplayHarness.layerWithRegistry({ name: "account-switch-mid-turn" }, registry, {
        runEffectWorker: false,
      }),
    ),
  );
});
