import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as DelegatedTaskQuestionReactor from "./DelegatedTaskQuestionReactor.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { taskReference } from "./taskReference.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for question notices"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "delegated-task-questions" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const NOTICE_COMMAND_PREFIX = "server:delegated-task-question:";

/** A parent with a delegated task, and a helper that makes the child's questions. */
const setup = Effect.fnUntraced(function* (
  key: string,
  completionWake: "always" | "settled_only" = "always",
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const parentThreadId = ThreadId.make(`thread:${key}-parent`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create-${key}-parent`),
    threadId: parentThreadId,
    projectId: ProjectId.make(`project:${key}`),
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
    commandId: CommandId.make(`start-${key}-parent`),
    threadId: parentThreadId,
    messageId: MessageId.make(`message:${key}-parent`),
    text: "Delegate the research",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  const parentRun = (yield* projections.getThreadProjection(parentThreadId)).runs[0]!;
  yield* orchestrator.dispatch({
    type: "delegated_task.request",
    commandId: CommandId.make(`delegate-${key}`),
    parentThreadId,
    parentRunId: parentRun.id,
    parentNodeId: parentRun.rootNodeId!,
    task: "Research the sources",
    completionWake,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "agent",
    creationSource: "mcp",
  });
  const task = (yield* projections.getThreadProjection(parentThreadId)).subagents[0]!;
  const childRun = (yield* projections.getThreadRecords(task.childThreadId!, ["runs"])).runs[0]!;
  const now = yield* DateTime.now;
  const question = (
    id: string,
    kind: "user_input" | "command" = "user_input",
    capability: "message" | "live" = "message",
  ) =>
    ({
      id: EventId.make(`event:${id}`),
      type: "runtime-request.updated",
      threadId: task.childThreadId!,
      runId: childRun.id,
      occurredAt: now,
      payload: {
        id: RuntimeRequestId.make(`request:${id}`),
        nodeId: childRun.rootNodeId!,
        providerTurnId: null,
        nativeRequestRef: null,
        kind,
        status: "pending",
        responseCapability:
          capability === "live"
            ? { type: "live", providerSessionId: ProviderSessionId.make(`session:${key}`) }
            : { type: "message" },
        createdAt: now,
        resolvedAt: null,
      },
    }) satisfies OrchestrationV2DomainEvent;
  const notices = projections
    .getThreadRecords(parentThreadId, ["messages"])
    .pipe(
      Effect.map(({ messages }) =>
        messages.filter((message) => message.notification !== undefined),
      ),
    );
  const noticeCommandId = (event: ReturnType<typeof question>) =>
    `${NOTICE_COMMAND_PREFIX}${parentThreadId}:${event.payload.id}`;
  const parentCompleted = {
    id: EventId.make(`event:${key}-parent-completed`),
    type: "run.updated",
    threadId: parentThreadId,
    runId: parentRun.id,
    occurredAt: now,
    payload: { ...parentRun, status: "completed", completedAt: now },
  } satisfies OrchestrationV2DomainEvent;
  return { question, notices, noticeCommandId, parentCompleted, parentThreadId, task };
});

/**
 * The reactor, with its event subscriptions and notice dispatches observed, and the first
 * `failures` dispatches of each notice failing.
 */
const makeReactor = Effect.fnUntraced(function* (
  failures: (commandId: string) => number = () => 0,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const subscriptions: Array<OrchestrationV2DomainEvent["type"] | undefined> = [];
  const attempts = yield* Queue.unbounded<string>();
  const delivered = yield* Queue.unbounded<string>();
  const attemptCounts = new Map<string, number>();
  const dispatch: Orchestrator.OrchestratorV2["Service"]["dispatch"] = (command) =>
    Effect.suspend(() => {
      if (!command.commandId.startsWith(NOTICE_COMMAND_PREFIX)) {
        return orchestrator.dispatch(command);
      }
      const attempt = (attemptCounts.get(command.commandId) ?? 0) + 1;
      attemptCounts.set(command.commandId, attempt);
      return Queue.offer(attempts, command.commandId).pipe(
        Effect.andThen(
          attempt <= failures(command.commandId)
            ? Effect.fail(
                new Orchestrator.OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause: "database is locked",
                }),
              )
            : orchestrator
                .dispatch(command)
                .pipe(Effect.tap(() => Queue.offer(delivered, command.commandId))),
        ),
      );
    });
  const reactor = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor.pipe(
    Effect.provide(
      DelegatedTaskQuestionReactor.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Orchestrator.OrchestratorV2, { ...orchestrator, dispatch }),
            Layer.succeed(EventSink.EventSinkV2, {
              ...eventSink,
              stream: (input) => {
                subscriptions.push(input?.eventType);
                return eventSink.stream(input);
              },
            }),
          ),
        ),
      ),
    ),
  );
  return { reactor, attempts, delivered, subscriptions };
});

it.live("relays a question its child asked before the reactor started exactly once", () =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const { question, notices, noticeCommandId, task } = yield* setup("startup-question");
    const asked = question("startup-asked");
    // Committed before the reactor runs, as when the server exits before the parent is told.
    const questions = [
      {
        id: "target",
        header: "Target",
        question: "Which target should the subagent use?",
        options: [
          { label: "Local", description: "Use this machine", value: "local" },
          { label: "Remote", description: "Use the server", value: "remote" },
        ],
      },
    ];
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("event:startup-question-item"),
          type: "turn-item.updated",
          threadId: asked.threadId,
          runId: asked.runId,
          occurredAt: asked.occurredAt,
          payload: {
            id: TurnItemId.make("item:startup-question"),
            threadId: asked.threadId,
            runId: asked.runId ?? null,
            nodeId: asked.payload.nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "waiting",
            title: "Choose target",
            startedAt: asked.occurredAt,
            completedAt: null,
            updatedAt: asked.occurredAt,
            type: "user_input_request",
            requestId: asked.payload.id,
            questions,
          },
        },
        asked,
        question("startup-approval", "command"),
      ],
    });

    const { reactor, delivered } = yield* makeReactor();
    yield* reactor.start();
    assert.equal(
      yield* Queue.take(delivered).pipe(Effect.timeout("5 seconds")),
      noticeCommandId(asked),
    );
    const [notice] = yield* notices;
    assert.include(notice?.text, `requestId:"${asked.payload.id}"`);
    assert.include(
      notice?.text,
      `{threadId:"${taskReference(task.id)}",requestId:"${asked.payload.id}"}`,
    );
    assert.notInclude(
      notice?.text,
      `{threadId:"${task.childThreadId}",requestId:"${asked.payload.id}"}`,
    );
    assert.include(notice?.text, "question (codex/gpt-5.1-codex), still working");
    assert.include(notice?.text, JSON.stringify(questions));
    assert.include(notice?.text, "t3_pending_request_respond");
    assert.notInclude(notice?.text, "t3_pending_request_read");

    // Later questions arrive on the live tail.
    const later = question("startup-later");
    yield* eventSink.write({ events: [later] });
    assert.equal(
      yield* Queue.take(delivered).pipe(Effect.timeout("5 seconds")),
      noticeCommandId(later),
    );
    assert.lengthOf(yield* notices, 2);

    // The next start finds both questions still pending and delivers neither again.
    yield* reactor.start();
    const relayed = [
      yield* Queue.take(delivered).pipe(Effect.timeout("5 seconds")),
      yield* Queue.take(delivered).pipe(Effect.timeout("5 seconds")),
    ];
    assert.sameMembers(relayed, [noticeCommandId(asked), noticeCommandId(later)]);
    assert.lengthOf(yield* notices, 2);
  }).pipe(Effect.provide(layerTest)),
);

it.live("follows only the run and question updates it handles", () =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const { question, notices, noticeCommandId, parentCompleted } = yield* setup(
      "tail-question",
      "settled_only",
    );
    const { reactor, delivered, subscriptions } = yield* makeReactor();
    yield* reactor.start();
    // While the parent's delegate_task wait runs, the wait delivers a live question itself.
    const blocked = question("tail-blocked", "user_input", "live");
    yield* eventSink.write({ events: [blocked] });
    // Once that wait ends with the parent's run, the question is relayed.
    yield* eventSink.write({ events: [parentCompleted] });
    assert.equal(
      yield* Queue.take(delivered).pipe(Effect.timeout("5 seconds")),
      noticeCommandId(blocked),
    );
    const [notice] = yield* notices;
    assert.include(notice?.text, "question (codex/gpt-5.1-codex), blocked");
    // A busy parent never leaves the reactor buffering every other thread's transcript.
    assert.sameMembers(subscriptions, ["run.updated", "runtime-request.updated"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("retries a question notice whose dispatch failed, a bounded number of times", () =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const { question, notices, noticeCommandId } = yield* setup("retried-question");
    const flaky = question("retried-flaky");
    const failing = question("retried-failing");
    yield* eventSink.write({ events: [flaky, failing] });
    const { reactor, attempts } = yield* makeReactor((commandId) =>
      commandId === noticeCommandId(flaky) ? 1 : commandId === noticeCommandId(failing) ? 99 : 0,
    );

    const retried = yield* reactor.handle(flaky).pipe(Effect.forkChild({ startImmediately: true }));
    assert.equal(yield* Queue.take(attempts), noticeCommandId(flaky));
    yield* TestClock.adjust("1 minute");
    yield* Fiber.join(retried);
    assert.deepEqual(yield* Queue.clear(attempts), [noticeCommandId(flaky)]);
    const [notice] = yield* notices;
    assert.include(notice?.text, `requestId:"${flaky.payload.id}"`);

    const givenUp = yield* reactor
      .handle(failing)
      .pipe(Effect.forkChild({ startImmediately: true }));
    for (let retry = 0; retry < 3; retry++) {
      assert.equal(yield* Queue.take(attempts), noticeCommandId(failing));
      yield* TestClock.adjust("1 minute");
    }
    assert.equal(yield* Queue.take(attempts), noticeCommandId(failing));
    yield* Fiber.join(givenUp);
    assert.deepEqual(yield* Queue.clear(attempts), []);
    assert.lengthOf(yield* notices, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("leaves remote subagent questions to the remote reconciler", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const { parentCompleted, notices } = yield* setup("remote-question-catchup", "settled_only");
    const parent = yield* projections.getThreadRecords(parentCompleted.threadId, ["subagents"]);
    const task = parent.subagents[0]!;
    yield* sink.write({
      events: [
        {
          id: EventId.make("event:remote-question-task"),
          type: "subagent.updated",
          threadId: parent.thread.id,
          occurredAt: parentCompleted.occurredAt,
          payload: { ...task, remote: { environmentId: EnvironmentId.make("studio-test") } },
        },
      ],
    });
    const reads: string[] = [];
    const { reactor } = yield* makeReactor().pipe(
      Effect.provideService(ProjectionStore.ProjectionStoreV2, {
        ...projections,
        getThreadRecords: (threadId, fields, options) => {
          reads.push(threadId);
          return projections.getThreadRecords(threadId, fields, options);
        },
      }),
    );
    yield* reactor.handle(parentCompleted);
    assert.deepEqual(reads, [parent.thread.id]);
    assert.lengthOf(yield* notices, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("does not relay a foreign parent's question into a same-id local thread", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const { question, notices } = yield* setup("foreign-parent-question");
    const asked = question("foreign-parent-asked");
    const child = yield* projections.getThread(asked.threadId);
    yield* sink.write({
      events: [
        {
          id: EventId.make("event:foreign-parent-lineage"),
          type: "thread.metadata-updated",
          threadId: child.id,
          occurredAt: asked.occurredAt,
          payload: {
            ...child,
            lineage: {
              ...child.lineage,
              rootThreadId: child.id,
              parentEnvironmentId: EnvironmentId.make("mac-test"),
            },
          },
        },
        asked,
      ],
    });
    const { reactor } = yield* makeReactor();
    yield* reactor.handle(asked);
    assert.lengthOf(yield* notices, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.live("recovers pending delegated questions beyond the first page", () =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const { question } = yield* setup("paged-questions");
    yield* eventSink.write({
      events: Array.from({ length: 101 }, (_, i) => question(`paged-${i}`)),
    });
    const { reactor, delivered } = yield* makeReactor();
    yield* reactor.start();
    const ids = new Set<string>();
    for (let i = 0; i < 101; i++) {
      ids.add(yield* Queue.take(delivered).pipe(Effect.timeout("5 seconds")));
    }
    assert.equal(ids.size, 101);
  }).pipe(Effect.provide(layerTest)),
);
