import * as Fiber from "effect/Fiber";
import * as SubagentRankings from "../subagentRankings/SubagentRankings.ts";
import { terminalRunRecord } from "../subagentRankings/recording.ts";
import { projectThreadProjectionForWire } from "./WireProjection.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  EventId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Subagent,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  SECRET_REQUEST_TURN_ITEM_ID_PREFIX,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as DelegatedTaskQuestionReactor from "./DelegatedTaskQuestionReactor.ts";
import * as EventSink from "./EventSink.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "control-reads" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.effect("message dispatch seeks control items without walking the thread's tool history", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:indexed-command-controls");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-indexed-command-controls"),
      threadId,
      projectId: ProjectId.make("project:indexed-command-controls"),
      title: "Indexed controls",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const send = (id: string) => ({
      type: "message.dispatch" as const,
      commandId: CommandId.make(id),
      threadId,
      messageId: MessageId.make(id),
      text: id,
      attachments: [],
      dispatchMode: { type: "defer_start" as const },
      createdBy: "user" as const,
      creationSource: "web" as const,
    });
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const first = yield* orchestrator.dispatch(send("prepare"));
    const statements: Array<string> = [];
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
    // Both sends arrive while the first run is preparing. Their receipts and
    // durable queue positions must agree on which send acquired the thread first.
    const results = yield* Effect.all(
      ["follow-a", "follow-b"].map((id) => orchestrator.dispatch(send(id))),
      { concurrency: 2 },
    ).pipe(Effect.withTracer(tracer));
    const { runs } = yield* store.getThreadRecords(threadId, ["runs"]);
    assert.deepEqual(
      runs.map((run) => run.status),
      ["preparing", "queued", "queued"],
    );
    const acceptedOrder = results
      .toSorted((a, b) => a.sequence - b.sequence)
      .map(
        (result) =>
          result.storedEvents.flatMap(({ event }) =>
            event.type === "message.updated" ? [event.payload.id] : [],
          )[0],
      );
    assert.deepEqual(
      runs.slice(1).map((run) => run.userMessageId),
      acceptedOrder,
    );
    assert.deepEqual(
      runs.slice(1).map((run) => run.queuePosition),
      [1, 2],
    );
    assert.equal((yield* orchestrator.dispatch(send("prepare"))).sequence, first.sequence);
    assert.lengthOf((yield* store.getThreadRecords(threadId, ["runs"])).runs, 3);
    assert.isFalse(
      statements.some(
        (query) =>
          query.includes("MIN(ordinal) AS ordinal") || query.includes("node.kind IN ('tool_call'"),
      ),
    );
    const nodeRead = statements.find((query) =>
      query.includes("SELECT payload_json, node.node_id"),
    );
    assert.ok(nodeRead);
    const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${nodeRead}`);
    assert.match(
      plan.map((row) => row.detail).join("\n"),
      /SEARCH node USING INDEX sqlite_autoindex_orchestration_v2_projection_nodes_1 \(node_id=\?\)/,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "dispatches metadata, queue resume and request controls without hydrating unrelated history",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:control-dispatch");
      const now = yield* DateTime.now;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-control"),
        threadId,
        projectId: ProjectId.make("project:control-dispatch"),
        title: "Before",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      for (const enabled of [false, true]) {
        yield* orchestrator.dispatch({
          type: "thread.auto-settle.set",
          commandId: CommandId.make(`auto-settle-${enabled}`),
          threadId,
          enabled,
        });
        const updated = yield* projections.getThreadProjection(threadId);
        assert.equal(updated.thread.autoSettleDisabledAt == null, enabled);
        const shell = yield* projections.getThreadShell(threadId);
        assert.ok(shell);
        assert.equal(shell.autoSettleDisabledAt == null, enabled);
      }
      yield* sql`INSERT INTO orchestration_v2_projection_messages
      (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('obsolete', ${threadId}, NULL, NULL, 'assistant', 0, ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
      assert.equal((yield* Effect.exit(projections.getThreadProjection(threadId)))._tag, "Failure");
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-empty-queue"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("rename-control"),
        threadId,
        title: "After",
      });
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("mode-control"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("model-control"),
        threadId,
        modelSelection: { ...modelSelection, model: "gpt-6" },
      });
      const sessionId = ProviderSessionId.make("session:control-dispatch");
      yield* projections.apply({
        id: EventId.make("attach-control"),
        type: "provider-session.attached",
        threadId,
        occurredAt: now,
        payload: {
          id: sessionId,
          driver: adapter.driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: "/repo",
          model: "gpt-6",
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
      for (const mode of ["live", "message"] as const) {
        const requestId = RuntimeRequestId.make(`request:${mode}`);
        yield* projections.apply({
          id: EventId.make(`request:${mode}`),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: requestId,
            nodeId: NodeId.make(`node:${mode}`),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability:
              mode === "live"
                ? { type: "live", providerSessionId: sessionId }
                : { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        });
        const nodeId = NodeId.make(`node:${mode}`);
        yield* projections.apply({
          id: EventId.make(`node:${mode}`),
          type: "node.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId,
            runId: null,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "user_input_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        });
        yield* projections.apply({
          id: EventId.make(`item:${mode}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item:${mode}`),
            threadId,
            runId: null,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: mode === "live" ? 1 : 2,
            status: "waiting",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "user_input_request",
            requestId,
            questions: [],
          },
        });
        yield* orchestrator.dispatch(
          mode === "live"
            ? {
                type: "runtime-request.respond",
                commandId: CommandId.make(`respond:${mode}`),
                threadId,
                requestId,
                decision: "accept",
              }
            : {
                type: "thread.user-input.dismiss",
                commandId: CommandId.make(`respond:${mode}`),
                threadId,
                requestId,
              },
        );
        assert.equal(
          (yield* projections.getRuntimeRequest(threadId, requestId))?.status,
          "resolved",
        );
        const response = yield* projections.getRuntimeResponseContext(threadId, requestId);
        assert.equal(response.node?.status, mode === "live" ? "completed" : "cancelled");
        assert.equal(response.item?.status, mode === "live" ? "completed" : "cancelled");
      }
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("workspace-control"),
        threadId,
        worktreePath: "/new-repo",
      });
      const thread = yield* projections.getThread(threadId);
      assert.equal(thread.title, "After");
      assert.equal(thread.modelSelection.model, "gpt-6");
      assert.equal(thread.runtimeMode, "approval-required");
      assert.deepEqual(
        (yield* projections.getThreadProviderContext(threadId)).providerSessions,
        [],
      );
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          type, status, ordinal, updated_at, payload_json)
        VALUES ('obsolete-output', ${threadId}, NULL, NULL, NULL, NULL,
          'command_execution', 'completed', 900, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_plans
        (plan_id, thread_id, run_id, node_id, kind, status, payload_json)
        VALUES ('obsolete-plan', ${threadId}, NULL, 'old-node', 'proposed', 'completed', '{"obsolete":true}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_context_handoffs
        (context_handoff_id, thread_id, target_run_id, to_provider_thread_id, strategy, status, updated_at, payload_json)
        VALUES ('obsolete-handoff', ${threadId}, 'old-run', 'old-provider-thread', 'full_thread_summary', 'ready', ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("dispatch-with-old-history"),
        threadId,
        messageId: MessageId.make("fresh-input"),
        text: "Continue",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      const fresh = yield* projections.getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["user_message"],
      });
      assert.isAbove(fresh.turnItems.at(-1)!.ordinal, 900);
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-with-old-history"),
        threadId,
      });
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      assert.isTrue(
        (yield* outbox.listByCommandId(CommandId.make("archive-with-old-history"))).some(
          (effect) => effect.request.type === "delegated-tasks.stop",
        ),
      );
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-with-old-history"),
        threadId,
      });
      assert.isNotNull((yield* projections.getThread(threadId)).deletedAt);
      assert.isTrue(
        (yield* outbox.listByCommandId(CommandId.make("delete-with-old-history"))).some(
          (effect) => effect.request.type === "delegated-tasks.stop",
        ),
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("implements a proposed plan that the command projection leaves out", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:implement-plan");
    const planId = PlanId.make("plan:implement-plan");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-implement-plan"),
      threadId,
      projectId: ProjectId.make("project:implement-plan"),
      title: "Plan",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "plan",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* projections.apply({
      id: EventId.make("plan:implement-plan"),
      type: "plan.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: planId,
        threadId,
        runId: null,
        nodeId: NodeId.make("node:implement-plan"),
        kind: "proposed_plan",
        status: "active",
        markdown: "# Plan\n\n1. Do the thing.",
      },
    });

    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("implement-plan"),
      threadId,
      messageId: MessageId.make("implement-plan-input"),
      text: "Implement the plan.",
      attachments: [],
      sourcePlanRef: { threadId, planId },
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });

    assert.equal((yield* projections.getPlan(threadId, planId))?.status, "completed");
  }).pipe(Effect.provide(layerTest)),
);

// Stop's settle follow-up runs after the provider interrupt returns, possibly
// long after the Stop (retries) or again (an effect replayed after a crash).
// A later run's background work is not that Stop's to end.
it.effect("settles only the stopped run's background work, once", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:settle-binding");
    const providerThreadId = ProviderThreadId.make("provider-thread:settle-binding");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-settle-binding"),
      threadId,
      projectId: ProjectId.make("project:settle-binding"),
      title: "Settle binding",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* projections.apply({
      id: EventId.make("settle-binding:provider-thread"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: providerThreadId,
        driver: adapter.driver,
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 2,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    });
    const commandItem = (ordinal: number) => TurnItemId.make(`turn-item:settle-binding:${ordinal}`);
    for (const ordinal of [1, 2]) {
      const runId = RunId.make(`run:settle-binding:${ordinal}`);
      const attemptId = RunAttemptId.make(`attempt:settle-binding:${ordinal}`);
      const nodeId = NodeId.make(`node:settle-binding:${ordinal}`);
      const providerTurnId = ProviderTurnId.make(`provider-turn:settle-binding:${ordinal}`);
      yield* projections.apply({
        id: EventId.make(`settle-binding:run:${ordinal}`),
        type: "run.created",
        threadId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal,
          providerInstanceId: instanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make(`message:settle-binding:${ordinal}`),
          rootNodeId: nodeId,
          activeAttemptId: attemptId,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projections.apply({
        id: EventId.make(`settle-binding:attempt:${ordinal}`),
        type: "run-attempt.created",
        threadId,
        occurredAt: now,
        payload: {
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId: nodeId,
          providerInstanceId: instanceId,
          providerThreadId,
          providerTurnId,
          reason: "initial",
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projections.apply({
        id: EventId.make(`settle-binding:turn:${ordinal}`),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: providerTurnId,
          providerThreadId,
          nodeId,
          runAttemptId: attemptId,
          nativeTurnRef: null,
          ordinal,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projections.apply({
        id: EventId.make(`settle-binding:item:${ordinal}`),
        type: "turn-item.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: commandItem(ordinal),
          threadId,
          runId,
          nodeId,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: ordinal * 10,
          status: "running",
          title: `Background command ${ordinal}`,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "command_execution",
          input: `sleep ${ordinal}`,
        },
      });
    }
    const itemStatuses = Effect.map(projections.getThreadProjection(threadId), (projection) =>
      projection.turnItems
        .flatMap((item) => (item.type === "command_execution" ? [`${item.id}:${item.status}`] : []))
        .toSorted(),
    );
    // The settle that followed a Stop of run 1's turn, dispatched only after
    // run 2 had settled with work of its own.
    const settle = {
      type: "thread.background-work.settle",
      commandId: CommandId.make("stop-run-1:background-work-settled"),
      threadId,
      providerThreadId,
      providerTurnId: ProviderTurnId.make("provider-turn:settle-binding:1"),
    } as const;
    yield* orchestrator.dispatch(settle);
    assert.deepEqual(yield* itemStatuses, [
      `${commandItem(1)}:interrupted`,
      `${commandItem(2)}:running`,
    ]);

    // A settle that found nothing to end replays as a no-op, even after work
    // it would match appears: its receipt is recorded with no events.
    const emptySettle = {
      ...settle,
      commandId: CommandId.make("stop-run-1-again:background-work-settled"),
    };
    const first = yield* orchestrator.dispatch(emptySettle);
    assert.lengthOf(first.storedEvents, 0);
    yield* projections.apply({
      id: EventId.make("settle-binding:item:late"),
      type: "turn-item.updated",
      threadId,
      runId: RunId.make("run:settle-binding:1"),
      occurredAt: now,
      payload: {
        id: commandItem(3),
        threadId,
        runId: RunId.make("run:settle-binding:1"),
        nodeId: NodeId.make("node:settle-binding:1"),
        providerThreadId,
        providerTurnId: ProviderTurnId.make("provider-turn:settle-binding:1"),
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 30,
        status: "running",
        title: "Late background command",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "command_execution",
        input: "sleep 3",
      },
    });
    const replayed = yield* orchestrator.dispatch(emptySettle);
    assert.lengthOf(replayed.storedEvents, 0);
    assert.deepEqual(yield* itemStatuses, [
      `${commandItem(1)}:interrupted`,
      `${commandItem(2)}:running`,
      `${commandItem(3)}:running`,
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps delegated child pull-request links independent of the parent", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const parentThreadId = ThreadId.make("thread:parent-pr");
    const projectId = ProjectId.make("project:parent-pr");
    const parentPullRequest = {
      projectId,
      repository: "pingdotgg/t3code",
      number: 123,
      url: "https://github.com/pingdotgg/t3code/pull/123",
    };
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-parent-pr"),
      threadId: parentThreadId,
      projectId,
      title: "Parent with a linked PR",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature/parent-pr",
      worktreePath: "/repo-worktree",
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("link-parent-pr"),
      threadId: parentThreadId,
      linkedPullRequest: parentPullRequest,
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-parent-pr"),
      threadId: parentThreadId,
      messageId: MessageId.make("message:parent-pr"),
      text: "Delegate a review",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const parent = yield* projections.getThreadProjection(parentThreadId);
    const parentRun = parent.runs[0]!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate-parent-pr"),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "Review the changes",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const updatedParent = yield* projections.getThreadProjection(parentThreadId);
    const childThreadId = updatedParent.subagents[0]!.childThreadId!;
    const child = yield* projections.getThreadProjection(childThreadId);
    assert.isNull(child.thread.linkedPullRequest);
    assert.deepEqual(child.thread.pullRequests, []);
    assert.equal(child.thread.branch, parent.thread.branch);
    assert.equal(child.thread.worktreePath, parent.thread.worktreePath);
    assert.equal(child.thread.lineage.parentThreadId, parentThreadId);

    const childPullRequest = {
      ...parentPullRequest,
      number: 456,
      url: "https://github.com/pingdotgg/t3code/pull/456",
    };
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("link-child-pr"),
      threadId: childThreadId,
      linkedPullRequest: childPullRequest,
    });
    const linkedChild = yield* projections.getThreadProjection(childThreadId);
    assert.deepEqual(linkedChild.thread.linkedPullRequest, childPullRequest);
    assert.deepEqual(
      linkedChild.thread.pullRequests?.map((link) => link.number),
      [456],
    );
    const parentAfterChildLink = yield* projections.getThreadProjection(parentThreadId);
    assert.deepEqual(parentAfterChildLink.thread.linkedPullRequest, parentPullRequest);
    assert.deepEqual(parentAfterChildLink.thread.pullRequests, parent.thread.pullRequests);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("wakes the parent once when its delegated task asks a question", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const reactor = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor;
    const parentThreadId = ThreadId.make("thread:question-parent");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-question-parent"),
      threadId: parentThreadId,
      projectId: ProjectId.make("project:question"),
      title: "Parent",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-question-parent"),
      threadId: parentThreadId,
      messageId: MessageId.make("message:question-parent"),
      text: "Delegate the research",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const parentRun = (yield* projections.getThreadProjection(parentThreadId)).runs[0]!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate-question-task"),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "Research the sources",
      role: "research",
      completionWake: "settled_only",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const task = (yield* projections.getThreadProjection(parentThreadId)).subagents[0]!;
    // The role is data on the record; the child reads the brief exactly as the lead wrote it.
    assert.equal(task.role, "research");
    assert.equal(task.prompt, "Research the sources");
    const childRun = (yield* projections.getThreadRecords(task.childThreadId!, ["runs"])).runs[0]!;
    const now = yield* DateTime.now;
    const requestEvent = (
      eventId: string,
      requestId: string,
      responseCapability: "live" | "message" = "message",
      kind: "user_input" | "command" = "user_input",
      run = childRun,
    ) =>
      ({
        id: EventId.make(eventId),
        type: "runtime-request.updated",
        threadId: task.childThreadId!,
        runId: run.id,
        occurredAt: now,
        payload: {
          id: RuntimeRequestId.make(requestId),
          nodeId: run.rootNodeId!,
          providerTurnId: null,
          nativeRequestRef: null,
          kind,
          status: "pending",
          responseCapability:
            responseCapability === "live"
              ? { type: "live", providerSessionId: ProviderSessionId.make("session:question") }
              : { type: "message" },
          createdAt: now,
          resolvedAt: null,
        },
      }) satisfies OrchestrationV2DomainEvent;
    const question = requestEvent("event:question", "request:question", "live");
    const asyncQuestion = requestEvent("event:async-question", "request:async-question");
    const answered = requestEvent("event:answered", "request:answered", "live");
    const approval = requestEvent("event:approval", "request:approval", "message", "command");
    const eventSink = yield* EventSink.EventSinkV2;
    yield* eventSink.write({
      events: [question, asyncQuestion, answered, approval],
    });

    yield* reactor.handle(question);
    assert.isFalse(
      (yield* projections.getThreadProjection(parentThreadId)).messages.some(
        (message) => message.notification !== undefined,
      ),
    );
    yield* reactor.handle(asyncQuestion);
    assert.equal(
      (yield* projections.getThreadProjection(parentThreadId)).messages.filter(
        (message) => message.notification !== undefined,
      ).length,
      1,
    );
    yield* reactor.handle(asyncQuestion);
    yield* reactor.handle(answered);
    yield* eventSink.write({
      events: [
        {
          ...answered,
          id: EventId.make("event:answered-resolved"),
          payload: { ...answered.payload, status: "resolved", resolvedAt: now },
        },
      ],
    });
    yield* reactor.handle(answered);
    yield* reactor.handle(approval);

    const wakes = (yield* projections.getThreadProjection(parentThreadId)).messages.filter(
      (message) => message.notification !== undefined,
    );
    assert.include(wakes[0]?.text, "question (codex/gpt-5.1-codex), still working");
    assert.deepEqual(
      wakes.map((message) => message.notification),
      [
        {
          source: {
            kind: "delegated_task",
            taskIds: [task.id],
            childThreadId: task.childThreadId!,
          },
          outcome: "updated",
          summary: 'Delegated task "Research the sources" has a question',
        },
      ],
    );

    const wakeRun = (yield* projections.getThreadRecords(parentThreadId, ["runs"])).runs.find(
      (run) => run.userMessageId === wakes[0]!.id,
    )!;
    assert.equal(wakeRun.status, "queued");
    const resolved = {
      ...asyncQuestion,
      id: EventId.make("event:question-resolved"),
      payload: { ...asyncQuestion.payload, status: "resolved" as const, resolvedAt: now },
    };
    yield* eventSink.write({ events: [resolved] });
    yield* reactor.handle(resolved);
    assert.equal(
      (yield* projections.getThreadRecords(parentThreadId, ["runs"])).runs.find(
        (run) => run.id === wakeRun.id,
      )?.status,
      "cancelled",
    );
    const parentCompleted = {
      id: EventId.make("event:question-parent-completed"),
      type: "run.updated",
      threadId: parentThreadId,
      runId: parentRun.id,
      occurredAt: now,
      payload: { ...parentRun, status: "completed", completedAt: now },
    } satisfies OrchestrationV2DomainEvent;
    for (const status of [
      "preparing",
      "starting",
      "running",
      "queued",
      "cancelled",
      "rolled_back",
      "interrupted",
    ] as const) {
      yield* reactor.handle({ ...parentCompleted, payload: { ...parentRun, status } });
    }
    assert.equal(
      (yield* projections.getThreadRecords(parentThreadId, ["messages"])).messages.length,
      2,
    );
    yield* eventSink.write({ events: [parentCompleted] });
    for (const state of ["disposed", "pending"] as const) {
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`event:question-task-${state}`),
            type: "subagent.updated",
            threadId: parentThreadId,
            occurredAt: now,
            payload: { ...task, completionDelivery: { state, observedByRunId: null } },
          },
        ],
      });
      yield* reactor.handle(parentCompleted);
      if (state === "disposed") {
        assert.equal(
          (yield* projections.getThreadRecords(parentThreadId, ["messages"])).messages.length,
          2,
        );
      }
    }
    yield* reactor.handle(parentCompleted);
    const caughtUp = (yield* projections.getThreadProjection(parentThreadId)).messages.filter(
      (message) => message.notification !== undefined,
    );
    assert.equal(caughtUp.length, 2);
    assert.equal(
      caughtUp.filter((message) => message.text.includes(`requestId:"${question.payload.id}"`))
        .length,
      1,
    );
    assert.include(caughtUp[1]?.text, "question (codex/gpt-5.1-codex), blocked");
    assert.isFalse(
      caughtUp.some((message) => message.text.includes(`requestId:"${answered.payload.id}"`)),
    );
    yield* reactor.handle(question);
    assert.equal(
      (yield* projections.getThreadProjection(parentThreadId)).messages.filter(
        (message) => message.notification !== undefined,
      ).length,
      2,
    );
    const terminalQuestion = requestEvent(
      "event:terminal-question",
      "request:terminal-question",
      "live",
    );
    yield* eventSink.write({ events: [terminalQuestion] });
    yield* reactor.handle(terminalQuestion);
    assert.equal(
      (yield* projections.getThreadProjection(parentThreadId)).messages.filter(
        (message) => message.notification !== undefined,
      ).length,
      3,
    );
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("event:question-parent-running-again"),
          type: "run.updated",
          threadId: parentThreadId,
          runId: parentRun.id,
          occurredAt: now,
          payload: { ...parentRun, status: "running", completedAt: null },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "delegated_task.wake-policy",
      commandId: CommandId.make("terminal-question-wait-ended"),
      parentThreadId,
      taskId: task.id,
      completionWake: "always",
    });
    const upgradedQuestion = requestEvent(
      "event:upgraded-question",
      "request:upgraded-question",
      "live",
    );
    yield* eventSink.write({ events: [upgradedQuestion] });
    yield* reactor.handle(upgradedQuestion);
    assert.equal(
      (yield* projections.getThreadProjection(parentThreadId)).messages.filter(
        (message) => message.notification !== undefined,
      ).length,
      4,
    );
    const waitDelivered = requestEvent("event:wait-delivered", "request:wait-delivered", "live");
    const waitDeliveredParentCompleted = {
      ...parentCompleted,
      id: EventId.make("event:wait-delivered-parent-completed"),
    };
    yield* eventSink.write({ events: [waitDelivered, waitDeliveredParentCompleted] });
    yield* reactor.handle(waitDeliveredParentCompleted);
    assert.isFalse(
      (yield* projections.getThreadProjection(parentThreadId)).messages.some((message) =>
        message.text.includes(`requestId:"${waitDelivered.payload.id}"`),
      ),
    );
    yield* eventSink.write({
      commandId: CommandId.make("command:runtime-reconcile:question-followup"),
      events: [
        {
          id: EventId.make("event:question-child-completed"),
          type: "run.updated",
          threadId: task.childThreadId!,
          occurredAt: now,
          payload: { ...childRun, status: "completed", completedAt: now },
        },
        {
          id: EventId.make("event:question-task-completed"),
          type: "subagent.updated",
          threadId: parentThreadId,
          occurredAt: now,
          payload: {
            ...task,
            status: "completed",
            result: "Sources researched.",
            completedAt: now,
          },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("question-followup"),
      threadId: task.childThreadId!,
      messageId: MessageId.make("message:question-followup"),
      text: "Check the sources again",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const followup = (yield* projections.getThreadRecords(task.childThreadId!, ["runs"])).runs.find(
      (run) => run.userMessageId === "message:question-followup",
    )!;
    assert.isDefined(followup.delegatedTaskId);
    assert.notEqual(followup.delegatedTaskId, task.id);
    const followupQuestion = requestEvent(
      "event:followup-question",
      "request:followup-question",
      "live",
      "user_input",
      followup,
    );
    yield* eventSink.write({ events: [followupQuestion] });
    yield* reactor.handle(followupQuestion);
    const followupWake = (yield* projections.getThreadRecords(parentThreadId, [
      "messages",
    ])).messages.find((message) =>
      message.text.includes(`requestId:"${followupQuestion.payload.id}"`),
    )!;
    assert.deepEqual(followupWake.notification?.source, {
      kind: "delegated_task",
      taskIds: [followup.delegatedTaskId],
      childThreadId: task.childThreadId!,
    });
  }).pipe(Effect.provide(DelegatedTaskQuestionReactor.layer.pipe(Layer.provideMerge(layerTest)))),
);

it.effect("answers an ask_user card with every option the user picked", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:multi-choice-answer");
    const requestId = RuntimeRequestId.make("request:multi-choice-answer");
    const nodeId = NodeId.make("node:multi-choice-answer");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-multi-choice-answer"),
      threadId,
      projectId: ProjectId.make("project:multi-choice-answer"),
      title: "Clean up",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* projections.apply({
      id: EventId.make("request:multi-choice-answer"),
      type: "runtime-request.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: requestId,
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: null,
      },
    });
    yield* projections.apply({
      id: EventId.make("node:multi-choice-answer"),
      type: "node.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: nodeId,
        threadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: nodeId,
        kind: "user_input_request",
        status: "waiting",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: requestId,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      },
    });
    yield* projections.apply({
      id: EventId.make("item:multi-choice-answer"),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("item:multi-choice-answer"),
        threadId,
        runId: null,
        nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "waiting",
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "user_input_request",
        requestId,
        questions: [
          {
            id: "q1",
            header: "Delete data?",
            question: "Which should I delete?",
            options: [
              { label: "Old runs (~31 GB)", description: "Experiment output" },
              { label: "Hunt folders, raw + extracted", description: "Downloads" },
              { label: "Keep all of them", description: "Stop here" },
            ],
            multiSelect: true,
            allowCustomAnswer: true,
          },
        ],
      },
    });

    yield* orchestrator.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make("respond-multi-choice-answer"),
      threadId,
      requestId,
      answers: { q1: ["Old runs (~31 GB)", "Hunt folders, raw + extracted"] },
    });

    const projection = yield* projections.getThreadProjection(threadId);
    assert.equal(
      projection.messages.find((message) => message.id === `async-answer:${requestId}`)?.text,
      "Which should I delete?\n- Old runs (~31 GB)\n- Hunt folders, raw + extracted",
    );
    assert.equal((yield* projections.getRuntimeRequest(threadId, requestId))?.status, "resolved");
  }).pipe(Effect.provide(layerTest)),
);
it.effect.each([false, true])("rejects thread.create for an existing id (deleted: %s)", (deleted) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make(`thread:duplicate-create:${deleted}`);
    const create = {
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:duplicate-create"),
      title: "Original",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
      importedNativeThread: {
        ref: { driver: adapter.driver, nativeId: "native-original", strength: "strong" },
      },
    } as const;
    yield* orchestrator.dispatch(create);
    if (deleted) {
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make(`delete:${threadId}`),
        threadId,
      });
    }
    const before = yield* projections.getThread(threadId);
    assert.isNotNull(before.activeProviderThreadId);
    assert.equal(before.deletedAt !== null, deleted);
    const sequence = yield* orchestrator.getThreadEventSequence(threadId);
    yield* TestClock.adjust("1 second");
    const duplicate = {
      ...create,
      commandId: CommandId.make(`duplicate:${threadId}`),
      title: "Replacement",
      importedNativeThread: undefined,
    };
    const outcome = yield* orchestrator.dispatch(duplicate).pipe(Effect.result);
    assert.ok(Result.isFailure(outcome), "duplicate create must be rejected");
    const refused = outcome.failure;
    assert.equal(refused._tag, "OrchestratorThreadAlreadyExistsError");
    assert.equal(refused.message, `Thread ${threadId} already exists. Use a new thread id.`);
    assert.deepEqual(yield* projections.getThread(threadId), before);
    assert.equal(yield* orchestrator.getThreadEventSequence(threadId), sequence);
    const retried = yield* orchestrator.dispatch(duplicate).pipe(Effect.flip);
    assert.equal(retried._tag, "OrchestratorCommandPreviouslyRejectedError");
    assert.include(retried.message, refused.message);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("replays a thread.create receipt without changing the thread", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:create-receipt-replay");
    const create = {
      type: "thread.create",
      commandId: CommandId.make("create:receipt-replay"),
      threadId,
      projectId: ProjectId.make("project:duplicate-create"),
      title: "Original",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    } as const;
    const original = yield* orchestrator.dispatch(create);
    const before = yield* projections.getThread(threadId);
    const replayed = yield* orchestrator.dispatch(create);
    assert.equal(replayed.sequence, original.sequence);
    assert.deepEqual(replayed, original);
    assert.deepEqual(yield* projections.getThread(threadId), before);
    assert.equal(yield* orchestrator.getThreadEventSequence(threadId), original.sequence);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("holding and resuming a child queue refreshes its parent's shell", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const parentId = ThreadId.make("held-resume-parent");
    const childId = ThreadId.make("held-resume-child");
    for (const threadId of [parentId, childId]) {
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId: ProjectId.make("held-resume-project"),
        title: threadId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
    }
    const now = yield* DateTime.now;
    const child = yield* projections.getThread(childId);
    yield* projections.apply({
      id: EventId.make("held-resume-lineage"),
      type: "thread.metadata-updated",
      threadId: childId,
      occurredAt: now,
      payload: {
        ...child,
        lineage: {
          rootThreadId: parentId,
          parentThreadId: parentId,
          relationshipToParent: "subagent",
        },
        forkedFrom: { type: "node", nodeId: NodeId.make("held-task") },
      },
    });
    yield* projections.apply({
      id: EventId.make("held-resume-active"),
      type: "run.created",
      threadId: childId,
      occurredAt: now,
      payload: {
        id: RunId.make("held-resume-active"),
        threadId: childId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("active-message"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
    yield* projections.apply({
      id: EventId.make("held-resume-queued"),
      type: "run.created",
      threadId: childId,
      occurredAt: now,
      payload: {
        id: RunId.make("held-resume-run"),
        threadId: childId,
        ordinal: 2,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("held-message"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "queued",
        queueHeld: true,
        requestedAt: now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
    const before = yield* projections.getThread(parentId);
    const eventSink = yield* EventSink.EventSinkV2;
    const afterSequence = yield* eventSink.latestSequence();
    yield* orchestrator.dispatch({
      type: "queue.resume",
      commandId: CommandId.make("resume-held-child"),
      threadId: childId,
    });
    yield* eventSink.stream({ afterSequence, eventType: "thread.metadata-updated" }).pipe(
      Stream.filter((stored) => stored.event.threadId === parentId),
      Stream.runHead,
    );
    const after = yield* projections.getThread(parentId);
    assert.equal(after.title, before.title);
    assert.equal(after.runtimeMode, before.runtimeMode);
    assert.equal(after.interactionMode, before.interactionMode);
    const beforeHold = yield* eventSink.latestSequence();
    const { runs } = yield* projections.getThreadRecords(childId, ["runs"]);
    const queuedRun = runs.find((run) => run.status === "queued")!;
    yield* eventSink.writeWithEffects({
      events: [
        {
          id: EventId.make("hold-live-child"),
          type: "run.updated",
          threadId: childId,
          occurredAt: now,
          payload: { ...queuedRun, queueHeld: true },
        },
      ],
      effects: [],
    });
    yield* eventSink
      .stream({ afterSequence: beforeHold, eventType: "thread.metadata-updated" })
      .pipe(
        Stream.filter((stored) => stored.event.threadId === parentId),
        Stream.runHead,
      );
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["child wake", "parent follow-up", "restart continuation"] as const)(
  "refreshes completed subagent display for %s without delivering or ranking again",
  (source) => {
    const records: Array<string> = [];
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const parentId = ThreadId.make(`parent:${source}`);
      const now = yield* DateTime.now;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${source}`),
        threadId: parentId,
        projectId: ProjectId.make(`project:${source}`),
        title: "Parent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`start:${source}`),
        threadId: parentId,
        messageId: MessageId.make(`message:${source}`),
        text: "Delegate",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const parentRun = (yield* projections.getThreadProjection(parentId)).runs[0]!;
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make(`delegate:${source}`),
        parentThreadId: parentId,
        parentRunId: parentRun.id,
        parentNodeId: parentRun.rootNodeId!,
        task: "First task",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        completionWake: "always",
        createdBy: "agent",
        creationSource: "mcp",
      });
      const parent = yield* projections.getThreadProjection(parentId);
      const task = parent.subagents[0]!;
      const childId = task.childThreadId!;
      const originalRun = (yield* projections.getThreadProjection(childId)).runs[0]!;
      const item = parent.turnItems.find((item) => item.type === "subagent")!;
      // A published original task: display changes must never re-open its delivery.
      let completedTask: OrchestrationV2Subagent = {
        ...task,
        status: "completed" as const,
        result: "Original result",
        completedAt: now,
        completionDelivery: { state: "delivered" as const, observedByRunId: null },
      };
      yield* sink.write({
        commandId: CommandId.make(`publish:${source}`),
        events: [
          {
            id: EventId.make(`complete-run:${source}`),
            type: "run.updated",
            threadId: childId,
            occurredAt: now,
            payload: { ...originalRun, status: "completed", completedAt: now },
          },
          {
            id: EventId.make(`complete-task:${source}`),
            type: "subagent.updated",
            threadId: parentId,
            occurredAt: now,
            payload: completedTask,
          },
          {
            id: EventId.make(`complete-item:${source}`),
            type: "turn-item.updated",
            threadId: parentId,
            occurredAt: now,
            payload: { ...item, status: "completed", completedAt: now },
          },
        ],
      });
      yield* orchestrator.recoverDelegatedTasks;
      const before = yield* projections.getThreadProjection(parentId);
      completedTask = before.subagents[0]!;
      const rankingBefore = terminalRunRecord(completedTask, { isolated: false, fixRounds: 0 });
      const recordsBefore = records.length;
      assert.isAbove(recordsBefore, 0);
      const heldRun = {
        ...originalRun,
        id: RunId.make(`held:${source}`),
        ordinal: 4,
        status: "queued" as const,
        queueHeld: true,
        completedAt: null,
      };
      yield* sink.write({
        commandId: CommandId.make(`held:${source}`),
        events: [
          {
            id: EventId.make(`held:${source}`),
            type: "run.updated",
            threadId: childId,
            occurredAt: now,
            payload: heldRun,
          },
        ],
      });
      yield* orchestrator.recoverDelegatedTasks;
      assert.equal(
        projectThreadProjectionForWire(yield* projections.getThreadProjection(parentId))
          .subagents[0]!.status,
        "completed",
      );
      const update = (run: typeof originalRun, working: boolean) =>
        Effect.gen(function* () {
          const afterSequence = yield* sink.latestSequence();
          const observed = yield* sink
            .stream({ afterSequence, eventType: "subagent.updated" })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "subagent.updated" &&
                  stored.event.payload.id === task.id &&
                  stored.event.payload.childActivity?.runId === run.id &&
                  (stored.event.payload.childActivity.status === "running") === working,
              ),
              Stream.take(1),
              Stream.runCollect,
              Effect.forkScoped,
            );
          yield* sink.write({
            commandId: CommandId.make(`update:${run.id}:${run.status}:${run.queueHeld}`),
            events: [
              {
                id: EventId.make(`event:${run.id}:${run.status}:${run.queueHeld}`),
                type: "run.updated",
                threadId: childId,
                occurredAt: now,
                payload: run,
              },
            ],
          });
          yield* Fiber.join(observed);
          const display = projectThreadProjectionForWire(
            yield* projections.getThreadProjection(parentId),
          );
          assert.equal(display.subagents[0]!.status, working ? "running" : "completed");
          assert.equal(
            display.turnItems.find((row) => row.id === item.id)?.status,
            working ? "running" : "completed",
          );
          if (working) assert.isNull(display.subagents[0]!.completedAt);
          return display;
        });
      for (const ordinal of [2, 3]) {
        const startedAt = DateTime.add(now, { minutes: ordinal });
        const run = {
          ...originalRun,
          id: RunId.make(`later:${source}:${ordinal}`),
          ordinal,
          delegatedTaskId:
            source === "parent follow-up" ? NodeId.make(`follow-up:${ordinal}`) : undefined,
          restartContinuationOfRunId:
            source === "restart continuation" ? originalRun.id : undefined,
          status: "running" as const,
          requestedAt: startedAt,
          startedAt,
          completedAt: null,
        };
        yield* update(run, true);
        const shell = yield* projections.getThreadShell(parentId);
        // Parent still has an active turn, so shell work is gated until it settles.
        assert.isDefined(shell);
        const finishedAt = DateTime.add(startedAt, { minutes: 1 });
        yield* sink.write({
          commandId: CommandId.make(`reply:${run.id}`),
          events: [
            {
              id: EventId.make(`reply:${run.id}`),
              type: "turn-item.updated",
              threadId: childId,
              occurredAt: finishedAt,
              payload: {
                ...item,
                id: TurnItemId.make(`reply:${run.id}`),
                threadId: childId,
                runId: run.id,
                nodeId: null,
                type: "assistant_message",
                messageId: MessageId.make(`reply:${run.id}`),
                ordinal: ordinal * 100,
                text: `Latest result ${ordinal}`,
                streaming: false,
                status: "completed",
                startedAt,
                completedAt: finishedAt,
                updatedAt: finishedAt,
              },
            },
          ],
        });
        // A final reply can precede a long tail of background tool completions.
        yield* sink.write({
          commandId: CommandId.make(`background-tail:${run.id}`),
          events: [
            {
              id: EventId.make(`message:${run.id}`),
              type: "message.updated",
              threadId: childId,
              occurredAt: finishedAt,
              payload: {
                id: MessageId.make(`reply:${run.id}`),
                threadId: childId,
                runId: run.id,
                nodeId: null,
                role: "assistant",
                createdBy: "agent",
                creationSource: "provider",
                text: `Latest result ${ordinal}`,
                attachments: [],
                streaming: false,
                createdAt: startedAt,
                updatedAt: finishedAt,
              },
            },
            ...Array.from({ length: 70 }, (_, index) => ({
              id: EventId.make(`tail:${run.id}:${index}`),
              type: "turn-item.updated" as const,
              threadId: childId,
              occurredAt: finishedAt,
              payload: {
                ...item,
                id: TurnItemId.make(`tail:${run.id}:${index}`),
                threadId: childId,
                runId: run.id,
                nodeId: null,
                type: "dynamic_tool" as const,
                ordinal: ordinal * 100 + index + 1,
                toolName: "background",
                input: {},
                output: {},
                status: "completed" as const,
                startedAt,
                completedAt: finishedAt,
                updatedAt: finishedAt,
              },
            })),
          ],
        });
        const display = yield* update(
          { ...run, status: "completed", completedAt: finishedAt },
          false,
        );
        assert.equal(display.subagents[0]!.result, `Latest result ${ordinal}`);
        assert.isUndefined(display.subagents[0]!.childActivity);
        assert.equal(
          DateTime.toEpochMillis(display.subagents[0]!.completedAt!),
          DateTime.toEpochMillis(finishedAt),
        );
      }
      const after = yield* projections.getThreadProjection(parentId);
      assert.deepEqual(after.messages, before.messages);
      assert.deepEqual(after.contextTransfers, before.contextTransfers);
      assert.deepEqual(after.runs, before.runs);
      assert.equal(after.subagents.length, 1);
      assert.deepEqual(after.subagents[0]!.completionDelivery, completedTask.completionDelivery);
      assert.deepEqual(
        terminalRunRecord(after.subagents[0]!, { isolated: false, fixRounds: 0 }),
        rankingBefore,
      );
      assert.equal(records.length, recordsBefore);
      // Cold startup discovery works even when no display event was ever written.
      const laterRun = (yield* projections.getThreadProjection(childId)).runs.at(-1)!;
      yield* sink.write({
        commandId: CommandId.make(`cold:${source}`),
        events: [
          {
            id: EventId.make(`cold-task:${source}`),
            type: "subagent.updated",
            threadId: parentId,
            occurredAt: now,
            payload: completedTask,
          },
          {
            id: EventId.make(`cold-item:${source}`),
            type: "turn-item.updated",
            threadId: parentId,
            occurredAt: now,
            payload: { ...item, status: "completed" },
          },
          {
            id: EventId.make(`cold-run:${source}`),
            type: "run.updated",
            threadId: childId,
            occurredAt: now,
            payload: { ...laterRun, status: "queued", queueHeld: true },
          },
        ],
      });
      yield* orchestrator.recoverDelegatedTasks;
      assert.equal(
        projectThreadProjectionForWire(yield* projections.getThreadProjection(parentId))
          .subagents[0]!.status,
        "completed",
      );
      const resumed = {
        ...laterRun,
        status: "running" as const,
        completedAt: null,
        queueHeld: false,
      };
      yield* update(resumed, true);
      // Remove activity without changing the child, as on first boot after the update.
      yield* sink.write({
        commandId: CommandId.make(`clear:${source}`),
        events: [
          {
            id: EventId.make(`clear-task:${source}`),
            type: "subagent.updated",
            threadId: parentId,
            occurredAt: now,
            payload: completedTask,
          },
          {
            id: EventId.make(`clear-item:${source}`),
            type: "turn-item.updated",
            threadId: parentId,
            occurredAt: now,
            payload: { ...item, status: "completed" },
          },
        ],
      });
      yield* orchestrator.recoverDelegatedTasks;
      const recovered = projectThreadProjectionForWire(
        yield* projections.getThreadProjection(parentId),
      );
      assert.equal(recovered.subagents[0]!.status, "running");
      const resources = yield* projections.getExecutionResources(parentId, true);
      assert.equal(resources.find((resource) => resource.id === task.id)?.state, "running");

      assert.equal(recovered.turnItems.find((row) => row.id === item.id)?.status, "running");
      const bounded = projectThreadProjectionForWire(
        (yield* projections.getThreadSnapshotWindow(parentId, { rowLimit: 1, userTurnLimit: 1 }))
          .projection,
      );
      assert.equal(bounded.subagents.find((row) => row.id === task.id)?.status, "running");
      assert.equal(bounded.turnItems.find((row) => row.id === item.id)?.status, "running");
      if (source === "parent follow-up") {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("parent-follow-up-intake"),
          threadId: childId,
          messageId: MessageId.make("parent-follow-up-intake"),
          text: "Follow up from the parent",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "mcp",
          senderThreadId: parentId,
        });
        const followup = (yield* projections.getThreadProjection(parentId)).subagents.find(
          (row) => row.id !== task.id,
        )!;
        assert.isUndefined(followup.childActivity);
        assert.isNull(followup.result);
        assert.equal(followup.status, "pending");
      }
      yield* sink.write({
        commandId: CommandId.make(`settle-parent:${source}`),
        events: [
          {
            id: EventId.make(`settle-parent:${source}`),
            type: "run.updated",
            threadId: parentId,
            occurredAt: now,
            payload: { ...parentRun, status: "completed", completedAt: now },
          },
        ],
      });
      const waitingShell = yield* projections.getThreadShell(parentId);
      const pendingTasks = waitingShell?.pendingBackgroundTasks ?? [];
      assert.lengthOf(pendingTasks, 1);
      assert.equal(pendingTasks.find((task) => task.kind === "subagent")?.childThreadId, childId);

      if (source !== "parent follow-up") return;
      const cards = (yield* projections.getThreadProjection(parentId)).subagents;
      const followup = cards.find((card) => card.id !== task.id)!;
      const assigned = (yield* projections.getThreadProjection(childId)).runs.find(
        (run) => run.delegatedTaskId === followup.id,
      )!;
      const restarted = {
        ...assigned,
        id: RunId.make("restart-follow-up"),
        ordinal: assigned.ordinal + 1,
        status: "running" as const,
        delegatedTaskId: undefined,
        restartContinuationOfRunId: assigned.id,
      };
      const retry = {
        ...restarted,
        id: RunId.make("retry-follow-up"),
        ordinal: restarted.ordinal + 1,
        restartContinuationOfRunId: undefined,
        providerRetryContinuationOfRunId: restarted.id,
      };
      const stale = {
        runId: restarted.id,
        status: "running" as const,
        startedAt: DateTime.toEpochMillis(now),
        completedAt: null,
        result: null,
      };
      const applyRun = (run: typeof originalRun) =>
        projections.apply({
          type: "run.updated",
          id: EventId.make(`row:${run.id}:${run.status}`),
          threadId: childId,
          occurredAt: now,
          payload: run,
        });
      const applyCard = (card: typeof task) =>
        projections.apply({
          type: "subagent.updated",
          id: EventId.make(`row:${card.id}:${card.status}`),
          threadId: parentId,
          occurredAt: now,
          payload: card,
        });
      yield* applyRun({ ...assigned, status: "interrupted", completedAt: now });
      yield* applyRun(restarted);
      yield* applyCard({ ...completedTask, childActivity: stale });
      yield* applyCard({ ...followup, status: "running" });
      yield* projections.apply({
        type: "turn-item.updated",
        id: EventId.make("stale-original-card"),
        threadId: parentId,
        occurredAt: now,
        payload: { ...item, status: "completed", childActivity: stale },
      });
      yield* orchestrator.recoverDelegatedTasks;
      const corrected = yield* projections.getThreadProjection(parentId);
      const visible = projectThreadProjectionForWire(corrected);
      assert.deepEqual(
        visible.subagents.filter((row) => row.status === "running").map((row) => row.id),
        [followup.id],
      );
      assert.equal(visible.turnItems.find((row) => row.id === item.id)?.status, "completed");
      assert.isUndefined(corrected.subagents.find((row) => row.id === task.id)?.childActivity);
      // A retry does not reopen a published assignment, even across two continuation links.
      yield* applyRun({ ...restarted, status: "failed", completedAt: now });
      yield* applyRun(retry);
      yield* applyCard({
        ...followup,
        status: "completed",
        result: "Follow-up findings",
        completedAt: now,
      });
      assert.deepEqual(yield* projections.getSubagentActivityState(childId), []);
      // An independent owner turn belongs on the newest assignment's card, and only there.
      const owner = {
        ...assigned,
        id: RunId.make("owner-after-follow-up"),
        userMessageId: MessageId.make("owner-after-follow-up"),
        ordinal: retry.ordinal + 1,
        delegatedTaskId: undefined,
        status: "running" as const,
        requestedAt: DateTime.add(now, { hours: 1 }),
      };
      yield* applyRun(owner);
      yield* orchestrator.recoverDelegatedTasks;
      const afterOwner = yield* projections.getThreadProjection(parentId);
      assert.deepEqual(
        afterOwner.subagents
          .filter((row) => row.childActivity?.runId === owner.id)
          .map((row) => row.id),
        [followup.id],
      );
    }).pipe(
      Effect.provide(
        layerTest.pipe(
          Layer.provide(
            Layer.mock(SubagentRankings.SubagentRankings)({
              record: (runs) =>
                Effect.sync(() => {
                  records.push(...runs.map((run) => run.taskId));
                }),
            }),
          ),
        ),
      ),
    );
  },
);

const traceStatements = () => {
  const statements: Array<string> = [];
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
  return { statements, tracer };
};

// Record reads whose plan walks every node or turn item the thread holds, and message
// ordering, which reads every message item. A long chat has tens of thousands of each.
const threadWideRecordReads = (statements: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const wide: Array<string> = [];
    for (const query of statements) {
      if (query.includes("MIN(ordinal) AS ordinal")) {
        wide.push(query);
        continue;
      }
      const nodeRead = query.includes("node.started_at");
      const itemRead =
        query.includes("orchestration_v2_projection_turn_items") &&
        query.includes("ORDER BY ordinal ASC, turn_item_id ASC");
      if (!nodeRead && !itemRead) continue;
      const plan = (yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`))
        .map((row) => row.detail)
        .join("\n");
      if (
        /SCAN (node|orchestration_v2_projection_(nodes|turn_items))\b|_thread_run_idx \(thread_id=\?\)|_thread_ordinal_idx \(thread_id=\?\)/.test(
          plan,
        )
      ) {
        wide.push(`${query}\n${plan}`);
      }
    }
    return wide;
  });

it.effect("delegated task controls read the task's records, not the parent's history", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const parentThreadId = ThreadId.make("thread:bounded-task-controls");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-bounded-task-controls"),
      threadId: parentThreadId,
      projectId: ProjectId.make("project:bounded-task-controls"),
      title: "Parent",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-bounded-task-controls"),
      threadId: parentThreadId,
      messageId: MessageId.make("message:bounded-task-controls"),
      text: "Delegate the research",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const parentRun = (yield* projections.getThreadProjection(parentThreadId)).runs[0]!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate-bounded-task-controls"),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "Research the sources",
      completionWake: "settled_only",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const task = (yield* projections.getThreadRecords(parentThreadId, ["subagents"])).subagents[0]!;
    // A finished task whose result nobody read yet, under a settled parent turn that
    // has more than one message to order.
    const now = yield* DateTime.now;
    const parentMessage = (id: string, role: "user" | "assistant") =>
      ({
        id: EventId.make(`event:${id}`),
        type: "message.updated",
        threadId: parentThreadId,
        runId: parentRun.id,
        occurredAt: now,
        payload: {
          id: MessageId.make(id),
          threadId: parentThreadId,
          runId: parentRun.id,
          nodeId: null,
          createdBy: role === "user" ? "user" : "agent",
          creationSource: "web",
          role,
          text: id,
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      }) as const;
    yield* eventSink.write({
      events: [
        parentMessage("message:bounded-task-controls:reply", "assistant"),
        parentMessage("message:bounded-task-controls:follow-up", "user"),
        {
          id: EventId.make("event:bounded-task-controls:parent-done"),
          type: "run.updated",
          threadId: parentThreadId,
          runId: parentRun.id,
          occurredAt: now,
          payload: { ...parentRun, status: "completed", completedAt: now },
        },
        {
          id: EventId.make("event:bounded-task-controls:task-done"),
          type: "subagent.updated",
          threadId: parentThreadId,
          occurredAt: now,
          payload: {
            ...task,
            status: "completed",
            completedAt: now,
            completionDelivery: { state: "pending", observedByRunId: null },
          },
        },
      ],
    });

    const { statements, tracer } = traceStatements();
    yield* Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "delegated_task.completion-delivery.acknowledge",
        commandId: CommandId.make("read-bounded-task-result-elsewhere"),
        parentThreadId,
        taskId: task.id,
        observedByRunId: null,
      });
      yield* orchestrator.dispatch({
        type: "delegated_task.wake-policy",
        commandId: CommandId.make("wake-for-bounded-task"),
        parentThreadId,
        taskId: task.id,
        completionWake: "always",
      });
      yield* orchestrator.dispatch({
        type: "delegated_task.remote.sync",
        commandId: CommandId.make("sync-bounded-remote-task"),
        threadId: parentThreadId,
        task: {
          ...task,
          id: NodeId.make("task:bounded-remote"),
          remote: { environmentId: EnvironmentId.make("environment:studio") },
          childThreadId: ThreadId.make("thread:bounded-remote-child"),
          status: "running",
          completionDelivery: undefined,
          completedAt: null,
        },
      });
    }).pipe(Effect.withTracer(tracer));

    const records = yield* projections.getThreadRecords(parentThreadId, ["subagents", "turnItems"]);
    assert.equal(
      records.subagents.find((candidate) => candidate.id === task.id)?.completionWake,
      "always",
    );
    assert.isTrue(
      records.turnItems.some(
        (item) => item.type === "subagent" && item.subagentId === "task:bounded-remote",
      ),
    );
    assert.deepEqual(yield* threadWideRecordReads(statements), []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("Stop reads the stopped run and the thread's running background work", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:bounded-stop");
    const providerThreadId = ProviderThreadId.make("provider-thread:bounded-stop");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-bounded-stop"),
      threadId,
      projectId: ProjectId.make("project:bounded-stop"),
      title: "Bounded stop",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    // The provider session is gone, so Stop ends the turn and its background work itself.
    yield* projections.apply({
      id: EventId.make("bounded-stop:provider-thread"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: providerThreadId,
        driver: adapter.driver,
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: 1,
        lastRunOrdinal: 2,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    });
    const runId = (ordinal: number) => RunId.make(`run:bounded-stop:${ordinal}`);
    const rootId = (ordinal: number) => NodeId.make(`node:bounded-stop:${ordinal}`);
    const itemBase = (ordinal: number, itemOrdinal: number, suffix: string) => ({
      id: TurnItemId.make(`turn-item:bounded-stop:${ordinal}:${suffix}`),
      threadId,
      runId: runId(ordinal),
      nodeId: rootId(ordinal),
      providerThreadId,
      providerTurnId: ProviderTurnId.make(`provider-turn:bounded-stop:${ordinal}`),
      nativeItemRef: null,
      parentItemId: null,
      ordinal: itemOrdinal,
      status: "running" as const,
      title: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    });
    for (const ordinal of [1, 2]) {
      const status = ordinal === 1 ? ("completed" as const) : ("running" as const);
      const attemptId = RunAttemptId.make(`attempt:bounded-stop:${ordinal}`);
      yield* projections.apply({
        id: EventId.make(`bounded-stop:run:${ordinal}`),
        type: "run.created",
        threadId,
        occurredAt: now,
        payload: {
          id: runId(ordinal),
          threadId,
          ordinal,
          providerInstanceId: instanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make(`message:bounded-stop:${ordinal}`),
          rootNodeId: rootId(ordinal),
          activeAttemptId: attemptId,
          status,
          requestedAt: now,
          startedAt: now,
          completedAt: status === "completed" ? now : null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projections.apply({
        id: EventId.make(`bounded-stop:attempt:${ordinal}`),
        type: "run-attempt.created",
        threadId,
        occurredAt: now,
        payload: {
          id: attemptId,
          runId: runId(ordinal),
          attemptOrdinal: 1,
          rootNodeId: rootId(ordinal),
          providerInstanceId: instanceId,
          providerThreadId,
          providerTurnId: ProviderTurnId.make(`provider-turn:bounded-stop:${ordinal}`),
          reason: "initial",
          status,
          startedAt: now,
          completedAt: status === "completed" ? now : null,
        },
      });
      yield* projections.apply({
        id: EventId.make(`bounded-stop:turn:${ordinal}`),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: ProviderTurnId.make(`provider-turn:bounded-stop:${ordinal}`),
          providerThreadId,
          nodeId: rootId(ordinal),
          runAttemptId: attemptId,
          nativeTurnRef: null,
          ordinal,
          status,
          startedAt: now,
          completedAt: status === "completed" ? now : null,
        },
      });
      yield* projections.apply({
        id: EventId.make(`bounded-stop:root:${ordinal}`),
        type: "node.updated",
        threadId,
        runId: runId(ordinal),
        nodeId: rootId(ordinal),
        occurredAt: now,
        payload: {
          id: rootId(ordinal),
          threadId,
          runId: runId(ordinal),
          parentNodeId: null,
          rootNodeId: rootId(ordinal),
          kind: "root_turn",
          status,
          countsForRun: true,
          providerThreadId,
          providerTurnId: ProviderTurnId.make(`provider-turn:bounded-stop:${ordinal}`),
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: status === "completed" ? now : null,
        },
      });
      yield* projections.apply({
        id: EventId.make(`bounded-stop:input:${ordinal}`),
        type: "message.updated",
        threadId,
        runId: runId(ordinal),
        occurredAt: now,
        payload: {
          id: MessageId.make(`message:bounded-stop:${ordinal}`),
          threadId,
          runId: runId(ordinal),
          nodeId: null,
          createdBy: "user",
          creationSource: "web",
          role: "user",
          text: `Turn ${ordinal}`,
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
    // The first turn left a command running; the second is replying and thinking.
    yield* projections.apply({
      id: EventId.make("bounded-stop:background"),
      type: "turn-item.updated",
      threadId,
      runId: runId(1),
      occurredAt: now,
      payload: { ...itemBase(1, 10, "command"), type: "command_execution", input: "sleep 60" },
    });
    yield* projections.apply({
      id: EventId.make("bounded-stop:reply"),
      type: "message.updated",
      threadId,
      runId: runId(2),
      occurredAt: now,
      payload: {
        id: MessageId.make("message:bounded-stop:reply"),
        threadId,
        runId: runId(2),
        nodeId: null,
        createdBy: "agent",
        creationSource: "server",
        role: "assistant",
        text: "Working",
        attachments: [],
        streaming: true,
        createdAt: now,
        updatedAt: now,
      },
    });
    yield* projections.apply({
      id: EventId.make("bounded-stop:reply-item"),
      type: "turn-item.updated",
      threadId,
      runId: runId(2),
      occurredAt: now,
      payload: {
        ...itemBase(2, 20, "reply"),
        type: "assistant_message",
        messageId: MessageId.make("message:bounded-stop:reply"),
        text: "Working",
        streaming: true,
      },
    });
    yield* projections.apply({
      id: EventId.make("bounded-stop:reasoning-item"),
      type: "turn-item.updated",
      threadId,
      runId: runId(2),
      occurredAt: now,
      payload: { ...itemBase(2, 21, "reasoning"), type: "reasoning", text: "", streaming: true },
    });

    const { statements, tracer } = traceStatements();
    yield* orchestrator
      .dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("stop-bounded"),
        threadId,
        runId: runId(2),
        holdQueue: true,
      })
      .pipe(Effect.withTracer(tracer));

    const after = yield* projections.getThreadProjection(threadId);
    const statusOf = (suffix: string) =>
      after.turnItems.find((item) => item.id.endsWith(`:${suffix}`))?.status;
    assert.equal(statusOf("command"), "interrupted");
    assert.notEqual(statusOf("reply"), "running");
    assert.notEqual(statusOf("reasoning"), "running");
    assert.isFalse(
      after.messages.find((message) => message.id === "message:bounded-stop:reply")!.streaming,
    );
    assert.deepEqual(yield* threadWideRecordReads(statements), []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "ask, secret, delegate, created-chat, background-settle and delete commands avoid thread-wide node and turn-item scans",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:bounded-controls");
      const threadId = ThreadId.make("thread:bounded-controls");
      const createdThreadId = ThreadId.make("thread:bounded-controls:created");
      const providerThreadId = ProviderThreadId.make("provider-thread:bounded-controls");
      const runId = (ordinal: number) => RunId.make(`run:bounded-controls:${ordinal}`);
      const rootId = (ordinal: number) => NodeId.make(`node:bounded-controls:${ordinal}`);

      for (const [id, title] of [
        [threadId, "Bounded controls"],
        [createdThreadId, "Created chat"],
      ] as const) {
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${id}`),
          threadId: id,
          projectId,
          title,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
      }

      yield* projections.apply({
        id: EventId.make("bounded-controls:provider-thread"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "active",
          firstRunOrdinal: 1,
          lastRunOrdinal: 2,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      for (const ordinal of [1, 2]) {
        const status = ordinal === 1 ? ("completed" as const) : ("running" as const);
        const attemptId = RunAttemptId.make(`attempt:bounded-controls:${ordinal}`);
        yield* projections.apply({
          id: EventId.make(`bounded-controls:run:${ordinal}`),
          type: "run.created",
          threadId,
          occurredAt: now,
          payload: {
            id: runId(ordinal),
            threadId,
            ordinal,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make(`message:bounded-controls:${ordinal}`),
            rootNodeId: rootId(ordinal),
            activeAttemptId: attemptId,
            status,
            requestedAt: now,
            startedAt: now,
            completedAt: status === "completed" ? now : null,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
        yield* projections.apply({
          id: EventId.make(`bounded-controls:attempt:${ordinal}`),
          type: "run-attempt.created",
          threadId,
          occurredAt: now,
          payload: {
            id: attemptId,
            runId: runId(ordinal),
            attemptOrdinal: 1,
            rootNodeId: rootId(ordinal),
            providerInstanceId: instanceId,
            providerThreadId,
            providerTurnId: ProviderTurnId.make(`provider-turn:bounded-controls:${ordinal}`),
            reason: "initial",
            status,
            startedAt: now,
            completedAt: status === "completed" ? now : null,
          },
        });
        yield* projections.apply({
          id: EventId.make(`bounded-controls:turn:${ordinal}`),
          type: "provider-turn.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: ProviderTurnId.make(`provider-turn:bounded-controls:${ordinal}`),
            providerThreadId,
            nodeId: rootId(ordinal),
            runAttemptId: attemptId,
            nativeTurnRef: null,
            ordinal,
            status,
            startedAt: now,
            completedAt: status === "completed" ? now : null,
          },
        });
        yield* projections.apply({
          id: EventId.make(`bounded-controls:root:${ordinal}`),
          type: "node.updated",
          threadId,
          runId: runId(ordinal),
          nodeId: rootId(ordinal),
          occurredAt: now,
          payload: {
            id: rootId(ordinal),
            threadId,
            runId: runId(ordinal),
            parentNodeId: null,
            rootNodeId: rootId(ordinal),
            kind: "root_turn",
            status,
            countsForRun: true,
            providerThreadId,
            providerTurnId: ProviderTurnId.make(`provider-turn:bounded-controls:${ordinal}`),
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: status === "completed" ? now : null,
          },
        });
      }

      // Pending background command on turn 1 + streaming assistant reply on turn 2.
      yield* projections.apply({
        id: EventId.make("bounded-controls:bg-cmd"),
        type: "turn-item.updated",
        threadId,
        runId: runId(1),
        occurredAt: now,
        payload: {
          id: TurnItemId.make("turn-item:bounded-controls:bg-cmd"),
          threadId,
          runId: runId(1),
          nodeId: rootId(1),
          providerThreadId,
          providerTurnId: ProviderTurnId.make("provider-turn:bounded-controls:1"),
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 10,
          status: "running",
          title: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "command_execution",
          input: "sleep 60",
        },
      });
      yield* projections.apply({
        id: EventId.make("bounded-controls:reply-msg"),
        type: "message.updated",
        threadId,
        runId: runId(2),
        occurredAt: now,
        payload: {
          id: MessageId.make("message:bounded-controls:reply"),
          threadId,
          runId: runId(2),
          nodeId: null,
          createdBy: "agent",
          creationSource: "server",
          role: "assistant",
          text: "Working",
          attachments: [],
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projections.apply({
        id: EventId.make("bounded-controls:reply-item"),
        type: "turn-item.updated",
        threadId,
        runId: runId(2),
        occurredAt: now,
        payload: {
          id: TurnItemId.make("turn-item:bounded-controls:reply"),
          threadId,
          runId: runId(2),
          nodeId: rootId(2),
          providerThreadId,
          providerTurnId: ProviderTurnId.make("provider-turn:bounded-controls:2"),
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 20,
          status: "running",
          title: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "assistant_message",
          messageId: MessageId.make("message:bounded-controls:reply"),
          text: "Working",
          streaming: true,
        },
      });

      const runTraced = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const { statements, tracer } = traceStatements();
          const result = yield* effect.pipe(Effect.withTracer(tracer));
          const wide = yield* threadWideRecordReads(statements);
          assert.deepEqual(
            wide,
            [],
            `${label} performed thread-wide reads:\n${wide.join("\n---\n")}`,
          );
          return result;
        });

      // 1. user_question.ask
      const questionRequestId = RuntimeRequestId.make("request:bounded-controls:q1");
      yield* runTraced(
        "user_question.ask",
        orchestrator.dispatch({
          type: "user_question.ask",
          commandId: CommandId.make("cmd:bounded-controls:ask"),
          threadId,
          runId: runId(2),
          nodeId: rootId(2),
          requestId: questionRequestId,
          turnItemId: TurnItemId.make("turn-item:bounded-controls:q1"),
          questions: [
            {
              id: "q1",
              header: "Choice",
              question: "Proceed?",
              options: [{ label: "Yes", description: "Continue" }],
            },
          ],
        }),
      );

      // 2. secret_request.record (initial ask + saved update)
      const secretTurnItemId = TurnItemId.make(
        `${SECRET_REQUEST_TURN_ITEM_ID_PREFIX}bounded-controls:secret1`,
      );
      yield* runTraced(
        "secret_request.record(pending)",
        orchestrator.dispatch({
          type: "secret_request.record",
          commandId: CommandId.make("cmd:bounded-controls:secret-ask"),
          threadId,
          runId: runId(2),
          nodeId: rootId(2),
          turnItemId: secretTurnItemId,
          label: "API Key",
          reason: "Needed for test",
          secretStatus: "pending",
        }),
      );
      yield* runTraced(
        "secret_request.record(saved)",
        orchestrator.dispatch({
          type: "secret_request.record",
          commandId: CommandId.make("cmd:bounded-controls:secret-save"),
          threadId,
          runId: runId(2),
          nodeId: rootId(2),
          turnItemId: secretTurnItemId,
          label: "API Key",
          reason: "Needed for test",
          secretStatus: "saved",
        }),
      );

      // 3. delegated_task.request
      yield* runTraced(
        "delegated_task.request",
        orchestrator.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make("cmd:bounded-controls:delegate"),
          parentThreadId: threadId,
          parentRunId: runId(2),
          parentNodeId: rootId(2),
          task: "Check status",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: "agent",
          creationSource: "mcp",
        }),
      );

      // 4. thread.created.record
      yield* runTraced(
        "thread.created.record",
        orchestrator.dispatch({
          type: "thread.created.record",
          commandId: CommandId.make("cmd:bounded-controls:created-record"),
          parentThreadId: threadId,
          parentRunId: runId(2),
          parentNodeId: rootId(2),
          targetThreadId: createdThreadId,
          targetRunId: null,
        }),
      );

      // 5. thread.background-work.settle
      yield* runTraced(
        "thread.background-work.settle",
        orchestrator.dispatch({
          type: "thread.background-work.settle",
          commandId: CommandId.make("cmd:bounded-controls:bg-settle"),
          threadId,
          providerThreadId,
          providerTurnId: ProviderTurnId.make("provider-turn:bounded-controls:2"),
        }),
      );

      const settled = yield* projections.getThreadProjection(threadId);
      assert.equal(
        settled.turnItems.find((item) => item.id === "turn-item:bounded-controls:bg-cmd")?.status,
        "interrupted",
      );
      assert.notEqual(
        settled.turnItems.find((item) => item.id === "turn-item:bounded-controls:reply")?.status,
        "running",
      );
      assert.isFalse(
        settled.messages.find((msg) => msg.id === "message:bounded-controls:reply")!.streaming,
      );
      assert.equal(
        settled.turnItems.find((item) => item.id === secretTurnItemId)?.status,
        "completed",
      );
      assert.isTrue(settled.runtimeRequests.some((req) => req.id === questionRequestId));

      // 6. thread.delete
      yield* runTraced(
        "thread.delete",
        orchestrator.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("cmd:bounded-controls:delete"),
          threadId,
        }),
      );
      const deleted = yield* projections.getThreadProjection(threadId);
      assert.isNotNull(deleted.thread.deletedAt);
    }).pipe(Effect.provide(layerTest)),
);
