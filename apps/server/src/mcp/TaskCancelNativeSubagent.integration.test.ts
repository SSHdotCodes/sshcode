import * as LocalFiles from "../assets/LocalFileAttachments.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Subagent,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const layerOrchestratorService = OrchestratorMcpService.layer.pipe(
  Layer.provide(Layer.mock(LocalFiles.LocalFileAttachments)({})),
  Layer.provide(
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
  ),
  Layer.provide(Layer.mock(UsageLimitSources.UsageLimitSources)({ current: Effect.succeed([]) })),
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "claude-test" };
const provider = {
  instanceId,
  driver,
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  models: [{ slug: modelSelection.model, name: modelSelection.model, isCustom: false }],
} as unknown as ServerProvider;

interface DelegatedChild {
  readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
  readonly worker: EffectWorker.OrchestrationEffectWorkerV2["Service"];
  readonly eventSink: EventSink.EventSinkV2["Service"];
  readonly service: OrchestratorMcpService.OrchestratorMcpService["Service"];
  /** The parent's MCP session. */
  readonly scope: McpInvocationScope;
  readonly parentThreadId: ThreadId;
  readonly parentTurn: Turn;
  readonly parentProviderTurn: OrchestrationV2ProviderTurn;
  /** Provider turns started so far, in order. */
  readonly turns: ReadonlyArray<Turn>;
  readonly task: OrchestrationV2Subagent;
  readonly child: Turn;
  readonly childTurn: OrchestrationV2ProviderTurn;
  readonly childProviderThread: OrchestrationV2ProviderThread;
  readonly watch: (
    predicate: (event: OrchestrationV2DomainEvent) => boolean,
  ) => Effect.Effect<Fiber.Fiber<void, Orchestrator.OrchestratorV2Error>, never, Scope.Scope>;
  /** What the provider does when a Stop reaches one of its turns. */
  readonly onInterrupt: (
    react: (input: ProviderAdapter.ProviderAdapterV2InterruptInput) => Effect.Effect<void>,
  ) => void;
}

interface Turn {
  readonly turn: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
}

/**
 * A Claude parent whose running turn delegated one task, with the child's
 * first turn running. Provider events are offered by hand. With `wakes`, a
 * finished task's result starts the parent's wake turn, as the live runtime does.
 */
const withDelegatedChild = <E>(
  name: string,
  body: (harness: DelegatedChild) => Effect.Effect<void, E, Scope.Scope>,
  options: { readonly wakes?: boolean } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(name);
      const turns: Array<Turn> = [];
      let interrupt: (
        input: ProviderAdapter.ProviderAdapterV2InterruptInput,
      ) => Effect.Effect<void> = () => Effect.void;
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
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
                capabilities: ClaudeProviderCapabilitiesV2,
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
                  nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
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
                  turns.push({ turn, events });
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                      providerThreadId: turn.providerThread.id,
                      nodeId: turn.rootNodeId,
                      runAttemptId: turn.attemptId,
                      nativeTurnRef: null,
                      ordinal: turn.providerTurnOrdinal,
                      status: "running",
                      startedAt: now,
                      completedAt: null,
                    },
                  });
                }),
              steerTurn: () => Effect.die("unused"),
              interruptTurn: (input) => interrupt(input),
              // As Claude does, a turn's events keep flowing while its thread lists background work.
              hasPendingBackgroundWorkForThread: (providerThread) =>
                Effect.succeed((providerThread.pendingBackgroundTasks?.length ?? 0) > 0),
              respondToRuntimeRequest: () => Effect.die("unused"),
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      const layerAdapters = ProviderAdapterRegistry.layerSingle(adapter);
      const layerOrchestrator = ProviderReplayHarness.layerWithRegistry({ name }, layerAdapters, {
        runEffectWorker: false,
        runContinuationWorker: options.wakes === true,
      });
      const layerOrchestration = Layer.merge(
        layerOrchestrator,
        ThreadManagementService.layer.pipe(
          Layer.provide(layerOrchestrator),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(
            CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
          ),
        ),
      );
      const layerTest = layerOrchestratorService.pipe(
        Layer.provideMerge(layerOrchestration),
        Layer.provide(
          Layer.mergeAll(
            layerAdapters,
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed([provider]),
              getModelFailures: Effect.succeed(new Map()),
            }),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            ServerSettings.layerTest(),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
            NodeServices.layer,
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const parentThreadId = ThreadId.make(`thread:${name}-parent`);
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        const turnRunning = () =>
          watch(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-parent"),
          threadId: parentThreadId,
          projectId: ProjectId.make(`project:${name}`),
          title: "Parent",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const parentRunning = yield* turnRunning();
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("start-parent"),
          threadId: parentThreadId,
          messageId: MessageId.make("message:start-parent"),
          text: "Delegate a review",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* Fiber.join(parentRunning);

        const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
        const childRunning = yield* turnRunning();
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make("delegate"),
          parentThreadId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId!,
          task: "Review the change",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "always",
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* worker.drain();
        yield* Fiber.join(childRunning);
        const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
        const child = turns.find((entry) => entry.turn.threadId === task.childThreadId)!;
        const childProjection = yield* orchestrator.getThreadProjection(task.childThreadId!);
        yield* body({
          orchestrator,
          worker,
          eventSink,
          service,
          scope: {
            environmentId: EnvironmentId.make(`environment:${name}`),
            requestNamespace: `provider-session:${name}`,
            thread: {
              threadId: parentThreadId,
              providerSessionId: `provider-session:${name}`,
              providerInstanceId: instanceId,
            },
            client: undefined,
            capabilities: new Set(["orchestration"]),
            issuedAt: 1,
          },
          parentThreadId,
          parentTurn: turns.find((entry) => entry.turn.threadId === parentThreadId)!,
          parentProviderTurn: (yield* orchestrator.getThreadProjection(parentThreadId))
            .providerTurns[0]!,
          turns,
          task,
          child,
          childTurn: childProjection.providerTurns[0]!,
          childProviderThread: childProjection.providerThreads[0]!,
          watch,
          onInterrupt: (react) => {
            interrupt = react;
          },
        });
      }).pipe(Effect.provide(layerTest));
    }),
  );

/** Ends a turn as Claude does: the provider turn completes, then the turn is terminal. */
const endTurn = (
  { turn, events }: Turn,
  providerTurn: OrchestrationV2ProviderTurn,
  before: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> = [],
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    for (const event of [
      ...before,
      {
        type: "provider_turn.updated",
        driver,
        providerTurn: { ...providerTurn, status: "completed", completedAt: now },
      },
      {
        type: "turn.terminal",
        driver,
        providerThreadId: providerTurn.providerThreadId,
        providerTurnId: providerTurn.id,
        runOrdinal: turn.runOrdinal,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      },
    ] satisfies ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) {
      yield* Queue.offer(events, event);
    }
  });

/** The child's report for the run it answers in. */
const childReport = (input: {
  readonly turn: Turn;
  readonly text: string;
  readonly now: DateTime.Utc;
}) =>
  ({
    type: "message.updated",
    driver,
    message: {
      id: MessageId.make(`message:report:${input.turn.turn.runId}`),
      threadId: input.turn.turn.threadId,
      runId: input.turn.turn.runId,
      nodeId: input.turn.turn.rootNodeId,
      role: "assistant",
      text: input.text,
      attachments: [],
      streaming: false,
      createdBy: "agent",
      creationSource: "provider",
      createdAt: input.now,
      updatedAt: input.now,
    },
  }) satisfies ProviderAdapter.ProviderAdapterV2Event;

const runSettled =
  (runId: RunId, status: "waiting" | "completed") => (event: OrchestrationV2DomainEvent) =>
    event.type === "run.updated" && event.payload.id === runId && event.payload.status === status;

/** The parent ends the turn that delegated, and its checkpoint settles the run. */
const endParentTurn = (harness: DelegatedChild) =>
  Effect.gen(function* () {
    const ended = yield* harness.watch(runSettled(harness.parentTurn.turn.runId, "waiting"));
    yield* endTurn(harness.parentTurn, harness.parentProviderTurn);
    yield* Fiber.join(ended);
    yield* harness.worker.drain();
  });

// A delegated Claude child ends its turn while a background native subagent it
// started keeps running (#17154). Cancelling the task stops the child, which
// ends that subagent's process, so the task must end instead of waiting on it.
const backgroundNativeSubagent = (then: "cancel" | "delegate") =>
  withDelegatedChild("task-cancel-native-subagent", (harness) =>
    Effect.gen(function* () {
      const { orchestrator, worker, service, scope, task, child, childTurn, watch } = harness;
      // The child starts a background native subagent, then ends its turn.
      const now = yield* DateTime.now;
      const subagentId = NodeId.make("node:native-subagent");
      const native = {
        threadId: task.childThreadId!,
        runId: child.turn.runId,
        origin: "provider_native",
        driver,
        providerInstanceId: instanceId,
        providerThreadId: childTurn.providerThreadId,
        childThreadId: null,
        prompt: "Check the tests",
        title: null,
        status: "running",
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      } as const;
      const waiting = yield* watch(runSettled(child.turn.runId, "waiting"));
      yield* endTurn(child, childTurn, [
        {
          type: "node.updated",
          driver,
          node: {
            id: subagentId,
            threadId: native.threadId,
            runId: native.runId,
            parentNodeId: child.turn.rootNodeId,
            rootNodeId: child.turn.rootNodeId,
            kind: "subagent",
            status: "running",
            countsForRun: false,
            providerThreadId: childTurn.providerThreadId,
            providerTurnId: childTurn.id,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        },
        {
          type: "subagent.updated",
          driver,
          subagent: {
            ...native,
            id: subagentId,
            parentNodeId: child.turn.rootNodeId,
            createdBy: "agent",
            nativeTaskRef: null,
            model: null,
          },
        },
        {
          type: "turn_item.updated",
          driver,
          turnItem: {
            ...native,
            id: TurnItemId.make("turn-item:native-subagent"),
            nodeId: subagentId,
            providerTurnId: childTurn.id,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            type: "subagent",
            subagentId,
          },
        },
      ]);
      yield* Fiber.join(waiting);
      yield* worker.drain();

      if (then === "delegate") {
        // The subagent calls delegate_task through the child's MCP session.
        const childScope: McpInvocationScope = {
          ...scope,
          thread: { ...scope.thread!, threadId: task.childThreadId! },
        };
        const delegated = yield* service.delegateTask(childScope, { task: "Reply OK." });
        assert.equal(delegated.status, "starting");
        return;
      }
      const before = yield* service.taskStatus(scope, task.id);
      assert.equal(before.status, "running");
      assert.equal(before.workState, "waiting_for_children");

      const cancelled = yield* service.cancelTask(scope, {
        taskId: task.id,
        clientRequestId: "cancel-task",
      });
      assert.equal(cancelled.status, "cancel_requested");
      yield* worker.drain();

      const childAfter = yield* orchestrator.getThreadProjection(task.childThreadId!);
      assert.equal(
        childAfter.subagents.find((entry) => entry.id === subagentId)?.status,
        "interrupted",
      );
      assert.equal(
        childAfter.nodes.find((entry) => entry.id === subagentId)?.status,
        "interrupted",
      );
      assert.equal(
        childAfter.turnItems.find((item) => item.type === "subagent")?.status,
        "interrupted",
      );
      // The child's own turn had completed, so the task keeps that result.
      const after = yield* service.taskStatus(scope, task.id);
      assert.equal(after.status, "completed");
      assert.notEqual(after.workState, "waiting_for_children");
    }),
  );

it.effect("task_cancel ends a delegated child's background native subagent", () =>
  backgroundNativeSubagent("cancel"),
);

it.effect("a background native subagent delegates after its run settled", () =>
  backgroundNativeSubagent("delegate"),
);

/** The parent's chat still shows the task as work it waits on. */
const parentWaitsOn = (harness: DelegatedChild) =>
  harness.orchestrator
    .getThreadShell(harness.parentThreadId)
    .pipe(
      Effect.map(
        (shell) =>
          shell?.pendingBackgroundTasks?.some(
            (work) => work.kind === "subagent" && work.childThreadId === harness.task.childThreadId,
          ) ?? false,
      ),
    );

// Seen live on 2026-11-22: a Claude review child answered and ended its turn while a
// `run_in_background` Bash it started still ran, so its task waited on that command. The
// parent cancelled the task; the Stop ended the command, but no run ended with it, so nothing
// settled the task and the parent showed "Waiting on subagent" until a restart.
it.effect("task_cancel settles a finished child whose background command it stopped", () =>
  withDelegatedChild("task-cancel-background-command", (harness) =>
    Effect.gen(function* () {
      const { orchestrator, worker, service, scope, task, child, childTurn, watch } = harness;
      const now = yield* DateTime.now;
      const roster = (
        pendingBackgroundTasks: OrchestrationV2ProviderThread["pendingBackgroundTasks"],
      ) =>
        ({
          type: "provider_thread.updated",
          driver,
          providerThread: { ...harness.childProviderThread, pendingBackgroundTasks },
        }) satisfies ProviderAdapter.ProviderAdapterV2Event;
      // Claude's Stop ends the command and reports an empty roster.
      harness.onInterrupt(() => Queue.offer(child.events, roster([])).pipe(Effect.asVoid));
      // The parent ends its turn after delegating, so its chat shows what it waits on.
      yield* endParentTurn(harness);
      const waiting = yield* watch(runSettled(child.turn.runId, "waiting"));
      yield* endTurn(child, childTurn, [
        roster([{ taskId: "bash-1", kind: "command", description: "npm test" }]),
        childReport({ turn: child, text: "Review: no blockers.", now }),
      ]);
      yield* Fiber.join(waiting);
      yield* worker.drain();
      assert.equal(
        (yield* orchestrator.getThreadProjection(task.childThreadId!)).runs[0]?.status,
        "completed",
      );
      const before = yield* service.taskStatus(scope, task.id);
      assert.equal(before.status, "running");
      assert.equal(before.workState, "waiting_for_children");
      assert.isTrue(yield* parentWaitsOn(harness));

      const settled = yield* watch(
        (event) =>
          event.type === "subagent.updated" &&
          event.payload.id === task.id &&
          event.payload.status === "completed",
      );
      const cancelled = yield* service.cancelTask(scope, {
        taskId: task.id,
        clientRequestId: "cancel-task",
      });
      assert.equal(cancelled.status, "cancel_requested");
      yield* worker.drain();
      yield* Fiber.join(settled);

      const parent = yield* orchestrator.getThreadProjection(harness.parentThreadId);
      const row = parent.subagents.find((entry) => entry.id === task.id)!;
      assert.equal(row.status, "completed");
      assert.equal(row.result, "Review: no blockers.");
      // The parent cancelled it, so its result wakes nothing.
      assert.equal(row.completionDelivery?.state, "disposed");
      assert.deepEqual(
        parent.runs.map((run) => run.id),
        [harness.parentTurn.turn.runId],
      );
      assert.isFalse(yield* parentWaitsOn(harness));
      const after = yield* service.taskStatus(scope, task.id);
      assert.equal(after.status, "completed");
      assert.equal(after.workState, "result_available");
    }),
  ),
);

it.effect("a cancel after a finished child woke its parent leaves the task completed", () =>
  withDelegatedChild(
    "task-cancel-after-wake",
    (harness) =>
      Effect.gen(function* () {
        const { orchestrator, worker, service, scope, task, child, childTurn, watch } = harness;
        const parentThreadId = harness.parentThreadId;
        const now = yield* DateTime.now;
        yield* endParentTurn(harness);
        const settled = yield* watch(
          (event) =>
            event.type === "subagent.updated" &&
            event.payload.id === task.id &&
            event.payload.status === "completed",
        );
        const wakeQueued = yield* watch(
          (event) => event.type === "run.created" && event.threadId === parentThreadId,
        );
        const childDone = yield* watch(runSettled(child.turn.runId, "waiting"));
        yield* endTurn(child, childTurn, [childReport({ turn: child, text: "All green.", now })]);
        yield* Fiber.join(childDone);
        yield* worker.drain();
        yield* Fiber.join(settled);
        // The finished task wakes the parent.
        yield* Fiber.join(wakeQueued);
        const wakeRunning = yield* watch(
          (event) =>
            event.type === "provider-turn.updated" &&
            event.threadId === parentThreadId &&
            event.payload.status === "running",
        );
        yield* worker.drain();
        yield* Fiber.join(wakeRunning);
        const wake = harness.turns.findLast((entry) => entry.turn.threadId === parentThreadId)!;
        assert.notEqual(wake.turn.runId, harness.parentTurn.turn.runId);

        // The woken parent reads the result, then cancels the finished task.
        const read = yield* service.taskStatus(scope, task.id);
        assert.equal(read.status, "completed");
        const cancelled = yield* service.cancelTask(scope, {
          taskId: task.id,
          clientRequestId: "cancel-finished-task",
        });
        assert.equal(cancelled.status, "completed");
        yield* worker.drain();
        // A second Stop of the finished child, as the chat's Stop sends it, changes nothing.
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop-finished-child"),
          threadId: task.childThreadId!,
        });
        yield* worker.drain();

        const wakeTurn = (yield* orchestrator.getThreadProjection(
          parentThreadId,
        )).providerTurns.find((turn) => turn.runAttemptId === wake.turn.attemptId)!;
        const wakeEnded = yield* watch(runSettled(wake.turn.runId, "waiting"));
        yield* endTurn(wake, wakeTurn);
        yield* Fiber.join(wakeEnded);
        yield* worker.drain();

        const parent = yield* orchestrator.getThreadProjection(parentThreadId);
        const row = parent.subagents.find((entry) => entry.id === task.id)!;
        assert.equal(row.status, "completed");
        assert.equal(row.result, "All green.");
        // Nothing waits: no second wake, and the parent's chat shows no work.
        assert.deepEqual(
          parent.runs.map((run) => [run.id, run.status]),
          [
            [harness.parentTurn.turn.runId, "completed"],
            [wake.turn.runId, "completed"],
          ],
        );
        assert.isFalse(yield* parentWaitsOn(harness));
        assert.isFalse(
          yield* orchestrator.delegatedTaskResultPending(task.childThreadId!, task.id),
        );
        const after = yield* service.taskStatus(scope, task.id);
        assert.equal(after.status, "completed");
        assert.equal(after.workState, "result_available");
      }),
    { wakes: true },
  ),
);

it.effect("task_status settles a finished task an earlier build left reading running", () =>
  withDelegatedChild("task-status-heals", (harness) =>
    Effect.gen(function* () {
      const { orchestrator, worker, eventSink, service, scope, task, child, childTurn, watch } =
        harness;
      const now = yield* DateTime.now;
      yield* endParentTurn(harness);
      const settled = yield* watch(
        (event) =>
          event.type === "subagent.updated" &&
          event.payload.id === task.id &&
          event.payload.status === "completed",
      );
      const childDone = yield* watch(runSettled(child.turn.runId, "waiting"));
      yield* endTurn(child, childTurn, [childReport({ turn: child, text: "Looks good.", now })]);
      yield* Fiber.join(childDone);
      yield* worker.drain();
      yield* Fiber.join(settled);
      // The row a build without the fix left: the child's work is over, the task reads running.
      const finished = (yield* orchestrator.getThreadProjection(
        harness.parentThreadId,
      )).subagents.find((entry) => entry.id === task.id)!;
      yield* eventSink.write({
        commandId: CommandId.make("command:runtime-reconcile:stale-task"),
        events: [
          {
            id: EventId.make("event:stale-task"),
            type: "subagent.updated",
            threadId: harness.parentThreadId,
            ...(finished.runId === null ? {} : { runId: finished.runId }),
            nodeId: finished.id,
            occurredAt: now,
            payload: { ...finished, status: "running", result: null, completedAt: null },
          },
        ],
      });
      assert.isTrue(yield* parentWaitsOn(harness));

      const read = yield* service.taskStatus(scope, task.id);
      assert.equal(read.status, "completed");
      const row = (yield* orchestrator.getThreadProjection(harness.parentThreadId)).subagents.find(
        (entry) => entry.id === task.id,
      )!;
      assert.equal(row.status, "completed");
      assert.equal(row.result, "Looks good.");
      assert.isFalse(yield* parentWaitsOn(harness));
    }),
  ),
);
