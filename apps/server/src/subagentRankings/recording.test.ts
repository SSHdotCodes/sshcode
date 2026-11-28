import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  RunId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as Rankings from "./SubagentRankings.ts";
import { isAccountFailure, isInfrastructureFailure, terminalRunRecord } from "./recording.ts";
import { RankingsState, inferTaskKind } from "./records.ts";
import { completedFollowUpsSince } from "./runTaskIds.ts";
import { catalog } from "../workflows/fixtures.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";

const parentId = ThreadId.make("parent");
const childId = ThreadId.make("child");
const instanceId = ProviderInstanceId.make("codex");
const at = DateTime.makeUnsafe("2026-11-06T00:00:00Z");
const finish = DateTime.add(at, { minutes: 21 });
const modelSelection = { instanceId, model: "gpt-6.1-sol" };
const task = (extra: Partial<OrchestrationV2Subagent> = {}): OrchestrationV2Subagent => ({
  id: NodeId.make("task"),
  threadId: parentId,
  runId: null,
  parentNodeId: NodeId.make("parent-node"),
  origin: "app_owned",
  createdBy: "agent",
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId: instanceId,
  providerThreadId: null,
  childThreadId: childId,
  nativeTaskRef: null,
  prompt: "secret prompt, research review ui code",
  title: "worker",
  model: modelSelection.model,
  modelSelection,
  status: "completed",
  result: "private result",
  startedAt: at,
  completedAt: finish,
  updatedAt: finish,
  ...extra,
});
const thread = (id: ThreadId): OrchestrationV2AppThread => ({
  id,
  createdBy: "agent",
  creationSource: "web",
  projectId: ProjectId.make("project"),
  title: id === childId ? "UI workflow box" : "Parent",
  providerInstanceId: instanceId,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: id === childId ? "/tmp/isolated-child" : "/tmp/parent",
  activeProviderThreadId: null,
  lineage: {
    parentThreadId: id === childId ? parentId : null,
    relationshipToParent: id === childId ? "subagent" : null,
    rootThreadId: parentId,
  },
  forkedFrom: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});
let eventOrdinal = 0;
const taskEvent = (value: OrchestrationV2Subagent): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event-${++eventOrdinal}`),
  type: "subagent.updated",
  threadId: parentId,
  occurredAt: finish,
  payload: value,
});
const decodeState = Schema.decodeEffect(Schema.fromJsonString(RankingsState));
const platform = ServerConfig.layerTest(process.cwd(), { prefix: "rankings-recording-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const testLayer = Layer.mergeAll(RuntimeLayer.layerEventSink, ProjectionStore.layer).pipe(
  Layer.provideMerge(Rankings.layer),
  Layer.provideMerge(
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([
        {
          ...catalog[0]!,
          models: [{ ...catalog[0]!.models[0]!, slug: "opaque", family: "explicit-family" }],
        },
      ]),
    }),
  ),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(platform),
);

it("uses only the anchored generated role prefix, metadata and catalog family", () => {
  const metadata = { isolated: false, fixRounds: 2 };
  expect(terminalRunRecord(task(), metadata)?.kind).toBe("other");
  for (const [role, kind] of [
    ["review", "review"],
    ["research", "research"],
    ["design", "ui"],
    ["implementation", "code"],
    ["test", "code"],
  ]) {
    expect(
      terminalRunRecord(
        task({ prompt: `Act as the ${role} sub-agent for this task.\n\nprivate text` }),
        metadata,
      )?.kind,
    ).toBe(kind);
  }
  expect(
    terminalRunRecord(
      task({ prompt: "untrusted text\nAct as the review sub-agent for this task.\n\n..." }),
      metadata,
    )?.kind,
  ).toBe("other");
  // The role now travels on the task record; the brief is sent as the lead wrote it.
  for (const [role, kind] of [
    ["review", "review"],
    ["research", "research"],
    ["design", "ui"],
    ["implementation", "code"],
    ["test", "code"],
  ] as const) {
    expect(terminalRunRecord(task({ role, prompt: "private text" }), metadata)?.kind).toBe(kind);
  }
  // The record wins over an old-style first line.
  expect(
    terminalRunRecord(
      task({ role: "review", prompt: "Act as the design sub-agent for this task.\n\nx" }),
      metadata,
    )?.kind,
  ).toBe("review");
  expect(terminalRunRecord(task({ title: "design workflow box" }), metadata)?.kind).toBe("ui");
  expect(
    terminalRunRecord(
      task({ title: "worker", model: "opaque", modelSelection: { instanceId, model: "opaque" } }),
      {
        ...metadata,
        provider: {
          ...catalog[0]!,
          models: [{ ...catalog[0]!.models[0]!, slug: "opaque", family: "custom-family" }],
        },
      },
    )?.family,
  ).toBe("custom-family");
  expect(terminalRunRecord(task(), { ...metadata, isolated: true })).toMatchObject({
    kind: "code",
    elapsedMs: 21 * 60000,
    fixRounds: 2,
  });
  expect(inferTaskKind("research", true)).toBe("research");
  expect(terminalRunRecord(task({ origin: "provider_native" }), metadata)).toBeUndefined();
  for (const status of ["idle", "pending", "running", "waiting"] as const)
    expect(terminalRunRecord(task({ status }), metadata)).toBeUndefined();
});

const kimiSubscription: OrchestrationV2ProviderFailure = {
  class: "provider_error",
  message:
    "Authentication required: 403 Your current subscription does not have access to Kimi Code right now. Upgrade your plan to keep coding with Kimi Code: https://www.kimi.com/code/",
  code: "-32000",
  retryable: null,
};
const modelFault: OrchestrationV2ProviderFailure = {
  class: "provider_error",
  message: "The model returned a tool call with invalid JSON arguments.",
  code: null,
  retryable: false,
};

it("leaves runs the provider account blocked out of the rankings", () => {
  const metadata = { isolated: false, fixRounds: 0 };
  expect(isAccountFailure(kimiSubscription)).toBe(true);
  for (const failureClass of [
    "usage_limit",
    "permission_error",
    "transport_error",
    "billing_error",
    "subscription_error",
    "authentication_error",
  ] as const)
    expect(isAccountFailure({ ...modelFault, class: failureClass })).toBe(true);
  for (const message of [
    "429 Too Many Requests",
    "Not logged in. Please run /login",
    "Invalid API key provided",
    "You exceeded your current quota",
    'API Error: 403 {"type":"error"}',
    "Request failed with status code 401",
    '{"status":429,"error":"slow down"}',
    "Connection reset by peer",
    "fetch failed",
    "getaddrinfo ENOTFOUND api.example.com",
  ])
    expect(isAccountFailure({ ...modelFault, message })).toBe(true);
  expect(isAccountFailure({ ...modelFault, code: "429", message: "slow" })).toBe(true);
  expect(isAccountFailure({ ...modelFault, code: "http_403", message: "no" })).toBe(true);
  expect(isAccountFailure({ ...modelFault, code: "rate_limit_error", message: "slow" })).toBe(true);
  expect(isAccountFailure(modelFault)).toBe(false);
  // Numbers that only look like status codes are still the model's failure.
  for (const message of [
    "Unexpected token } in JSON at position 403",
    "Tool output exceeded 4290 lines",
    "Edit failed at line 429 of src/app.ts",
  ])
    expect(isAccountFailure({ ...modelFault, message })).toBe(false);
  expect(
    terminalRunRecord(task({ status: "failed" }), {
      ...metadata,
      providerFailure: kimiSubscription,
    }),
  ).toBeUndefined();
  expect(
    terminalRunRecord(task({ status: "failed" }), { ...metadata, providerFailure: modelFault })
      ?.outcome,
  ).toBe("failed");
  // A run that finished counts, whatever errors it recovered from on the way.
  expect(
    terminalRunRecord(task(), { ...metadata, providerFailure: kimiSubscription })?.outcome,
  ).toBe("completed");
});

it.effect("does not attribute unbound child errors to a task", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    yield* sink.write({
      events: [parentId, childId].map((id) => ({
        id: EventId.make(`failure-thread-${id}`),
        type: "thread.created",
        threadId: id,
        occurredAt: at,
        payload: thread(id),
      })),
    });
    const errorItem = (ordinal: number, failure: OrchestrationV2ProviderFailure) => ({
      id: EventId.make(`failure-item-${ordinal}`),
      type: "turn-item.updated" as const,
      threadId: childId,
      occurredAt: at,
      payload: {
        id: TurnItemId.make(`turn-item:failure-${ordinal}`),
        threadId: childId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "failed" as const,
        title: "Provider error",
        startedAt: at,
        completedAt: at,
        updatedAt: at,
        type: "error" as const,
        failure,
      },
    });
    const saved = () =>
      Effect.flatMap(fs.readFileString(`${config.stateDir}/subagent-rankings.json`), decodeState);
    // Errors with no result run cannot establish which task encountered them.
    yield* sink.write({ events: [errorItem(1, modelFault), errorItem(2, kimiSubscription)] });
    yield* sink.write({
      events: [taskEvent(task({ id: NodeId.make("blocked"), status: "failed" }))],
    });
    yield* sink.write({ events: [taskEvent(task({ id: NodeId.make("finished") }))] });
    expect((yield* saved()).runs.map((r) => r.taskId)).toEqual(["blocked", "finished"]);
    yield* sink.write({ events: [errorItem(3, modelFault)] });
    yield* sink.write({
      events: [taskEvent(task({ id: NodeId.make("model-fault"), status: "failed" }))],
    });
    expect((yield* saved()).runs.map((r) => r.taskId).toSorted()).toEqual([
      "blocked",
      "finished",
      "model-fault",
    ]);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "records app-owned terminals synchronously with workflow labels, ignoring unbound parent messages",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const rankings = yield* Rankings.SubagentRankings;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const initial = DateTime.add(at, { milliseconds: 1 });
      yield* sink.write({
        events: [parentId, childId].map((id) => ({
          id: EventId.make(`thread-${id}`),
          type: "thread.created",
          threadId: id,
          occurredAt: at,
          payload: thread(id),
        })),
      });
      const messages = [
        { id: "initial", sender: parentId, role: "user" },
        { id: "followup1", sender: parentId, role: "user" },
        { id: "followup2", sender: parentId, role: "user" },
        { id: "direct-user", sender: undefined, role: "user" },
        { id: "other-agent", sender: ThreadId.make("other"), role: "user" },
        { id: "assistant", sender: parentId, role: "assistant" },
      ] as const;
      yield* sink.write({
        events: messages.map((m) => ({
          id: EventId.make(m.id),
          type: "message.updated",
          threadId: childId,
          occurredAt: initial,
          payload: {
            id: MessageId.make(m.id),
            threadId: childId,
            runId: null,
            nodeId: null,
            role: m.role,
            text: "sensitive body",
            createdBy: "agent",
            creationSource: "mcp",
            attachments: [],
            streaming: false,
            createdAt: initial,
            updatedAt: initial,
            ...(m.sender === undefined ? {} : { senderThreadId: m.sender }),
          },
        })),
      });
      yield* Effect.forEach(
        ["completed", "failed", "cancelled", "interrupted"] as const,
        (status) =>
          Effect.gen(function* () {
            const current = task({ id: NodeId.make(`task-${status}`), status });
            yield* sink.write({ events: [taskEvent(current)] });
            // Calling grade immediately after the terminal write must always find its record.
            yield* rankings.grade(current.id, { score: 3 });
          }),
        { concurrency: "unbounded" },
      );
      const snapshot = yield* rankings.getSnapshot();
      expect(snapshot.thumbs).toHaveLength(4);
      const saved = yield* decodeState(
        yield* fs.readFileString(`${config.stateDir}/subagent-rankings.json`),
      );
      expect(saved.runs.map((r) => r.outcome).toSorted()).toEqual([
        "cancelled",
        "completed",
        "failed",
        "interrupted",
      ]);
      expect(saved.runs.every((r) => r.fixRounds === 0 && r.kind === "ui")).toBe(true);
      expect(saved.runs.every((r) => r.elapsedMs === 21 * 60000)).toBe(true);
      const contents = yield* fs.readFileString(`${config.stateDir}/subagent-rankings.json`);
      expect(contents).not.toContain("sensitive");
      expect(contents).not.toContain("secret prompt");
      expect(contents).not.toContain("private result");
      yield* sink.write({
        events: [
          taskEvent(
            task({
              id: NodeId.make("opaque"),
              model: "opaque",
              modelSelection: { instanceId, model: "opaque" },
            }),
          ),
        ],
      });
      expect(
        (yield* decodeState(
          yield* fs.readFileString(`${config.stateDir}/subagent-rankings.json`),
        )).runs.find((r) => r.taskId === "opaque")?.family,
      ).toBe("explicit-family");
      yield* sink.write({
        events: [taskEvent(task({ origin: "provider_native", id: NodeId.make("native") }))],
      });
      expect((yield* rankings.getSnapshot()).thumbs).toHaveLength(5);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "counts an initial delegation only once even when its message was written after task start",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const rankings = yield* Rankings.SubagentRankings;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      for (const id of [parentId, childId])
        yield* store.apply({
          id: EventId.make(`initial-thread-${id}`),
          type: "thread.created",
          threadId: id,
          occurredAt: at,
          payload: thread(id),
        });
      const later = DateTime.add(at, { milliseconds: 5 });
      yield* store.apply({
        id: EventId.make("initial-msg"),
        type: "message.updated",
        threadId: childId,
        occurredAt: later,
        payload: {
          id: MessageId.make("initial-msg"),
          threadId: childId,
          runId: null,
          nodeId: null,
          role: "user",
          senderThreadId: parentId,
          text: "private",
          createdBy: "agent",
          creationSource: "mcp",
          attachments: [],
          streaming: false,
          createdAt: later,
          updatedAt: later,
        },
      });
      yield* yield* store.prepareSubagentRankings!([taskEvent(task())]);
      expect((yield* rankings.getSnapshot()).thumbs).toHaveLength(1);
      expect(
        (yield* decodeState(yield* fs.readFileString(`${config.stateDir}/subagent-rankings.json`)))
          .runs[0]?.fixRounds,
      ).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("does not record a terminal whose sqlite transaction rolls back", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const sql = yield* SqlClient.SqlClient;
    const rankings = yield* Rankings.SubagentRankings;
    // A constraint failure after the terminal projection must roll back the whole append.
    yield* sql`CREATE TRIGGER rankings_test_reject BEFORE INSERT ON orchestration_v2_projection_metadata BEGIN SELECT RAISE(ABORT, 'test rollback'); END`;
    expect((yield* sink.write({ events: [taskEvent(task())] }).pipe(Effect.result))._tag).toBe(
      "Failure",
    );
    expect((yield* rankings.getSnapshot()).thumbs).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("uses only the final task update in a committed batch", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const rankings = yield* Rankings.SubagentRankings;
    const completed = task({ childThreadId: null });
    const running = { ...completed, status: "running" as const, completedAt: null };
    yield* sink.write({ events: [taskEvent(completed), taskEvent(running)] });
    expect((yield* rankings.getSnapshot()).thumbs).toEqual([]);
    yield* sink.write({ events: [taskEvent(running), taskEvent(completed)] });
    expect((yield* rankings.getSnapshot()).thumbs).toEqual([{ taskId: completed.id }]);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect.each(["account", "outage-message", "outage-item"] as const)(
  "keeps ranking eligibility, model, output and fix rounds scoped to the task result run: %s",
  (mode) =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const ownId = RunId.make("own-result");
      const otherId = RunId.make("unrelated-followup");
      const ownTask = task({
        status: "failed",
        modelSelection: { instanceId, model: "requested-model" },
      });
      const childRun = (
        id: RunId,
        ordinal: number,
        delegatedTaskId: NodeId,
      ): OrchestrationV2DomainEvent => ({
        id: EventId.make(`ranking-run-${id}`),
        type: "run.updated",
        threadId: childId,
        occurredAt: finish,
        payload: {
          id,
          threadId: childId,
          ordinal,
          delegatedTaskId,
          providerInstanceId: ProviderInstanceId.make("actual-provider"),
          modelSelection: {
            instanceId: ProviderInstanceId.make("actual-provider"),
            model: ordinal === 1 ? "actual-model" : "other-model",
          },
          providerThreadId: null,
          userMessageId: MessageId.make(`input-${id}`),
          rootNodeId: null,
          activeAttemptId: null,
          status: "failed",
          requestedAt: at,
          startedAt: at,
          completedAt: finish,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      const error = (
        runId: RunId,
        ordinal: number,
        failure: OrchestrationV2ProviderFailure,
      ): OrchestrationV2DomainEvent => ({
        id: EventId.make(`ranking-error-${ordinal}`),
        type: "turn-item.updated",
        threadId: childId,
        occurredAt: finish,
        payload: {
          id: TurnItemId.make(`ranking-error-${ordinal}`),
          threadId: childId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal,
          type: "error",
          status: "failed",
          failure,
          title: "Error",
          startedAt: at,
          completedAt: finish,
          updatedAt: finish,
        },
      });
      yield* sink.write({
        events: [parentId, childId].map((id) => ({
          id: EventId.make(`scoped-thread-${id}`),
          type: "thread.created",
          threadId: id,
          occurredAt: at,
          payload: thread(id),
        })),
      });
      yield* sink.write({
        events: [
          childRun(ownId, 1, ownTask.id),
          error(
            ownId,
            1,
            mode === "account"
              ? kimiSubscription
              : { ...modelFault, message: "Claude gave up after repeated API errors." },
          ),
        ],
      });
      yield* sink.write({ events: [taskEvent(ownTask)] });
      yield* sink.write({
        events: [childRun(otherId, 2, NodeId.make("other-task")), error(otherId, 2, modelFault)],
      });
      yield* sink.write({
        events: [ownId, ownId, ownId, otherId, otherId].map((runId, index) => ({
          id: EventId.make(`scoped-message-${index}`),
          type: "message.updated",
          threadId: childId,
          occurredAt: finish,
          payload: {
            id: MessageId.make(`scoped-message-${index}`),
            threadId: childId,
            runId,
            nodeId: null,
            role: "user",
            text: "private",
            senderThreadId: parentId,
            createdBy: "agent",
            creationSource: "mcp",
            attachments: [],
            streaming: false,
            createdAt: at,
            updatedAt: at,
          },
        })),
      });
      // An acknowledgement repeats the original terminal row after unrelated work failed.
      yield* sink.write({
        events: [
          taskEvent({
            ...ownTask,
            completionDelivery: { state: "acknowledged", observedByRunId: null },
          }),
        ],
      });
      expect((yield* (yield* Rankings.SubagentRankings).getSnapshot()).thumbs).toEqual([]);
      if (mode !== "account") {
        const output = (runId: RunId, text = "Partial work"): OrchestrationV2DomainEvent => {
          const common = {
            threadId: childId,
            runId,
            nodeId: null,
            startedAt: at,
            completedAt: finish,
            updatedAt: finish,
          };
          return mode === "outage-message"
            ? {
                id: EventId.make(`${text.trim() ? "output" : "blank"}-${runId}`),
                type: "message.updated",
                threadId: childId,
                occurredAt: finish,
                payload: {
                  ...common,
                  id: MessageId.make(`output-${runId}`),
                  role: "assistant",
                  text,
                  createdBy: "agent",
                  creationSource: "provider",
                  attachments: [],
                  streaming: false,
                  createdAt: at,
                },
              }
            : {
                id: EventId.make(`${text.trim() ? "output" : "blank"}-${runId}`),
                type: "turn-item.updated",
                threadId: childId,
                occurredAt: finish,
                payload: {
                  ...common,
                  id: TurnItemId.make(`output-${runId}`),
                  type: "assistant_message",
                  status: "completed",
                  title: "Output",
                  ordinal: 3,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  text,
                  messageId: MessageId.make(`output-${runId}`),
                  streaming: false,
                },
              };
        };
        // Another task's output must not make this outage eligible.
        yield* sink.write({ events: [output(otherId), taskEvent(ownTask)] });
        expect((yield* (yield* Rankings.SubagentRankings).getSnapshot()).thumbs).toEqual([]);
        yield* sink.write({ events: [output(ownId, "\n\t "), taskEvent(ownTask)] });
        expect((yield* (yield* Rankings.SubagentRankings).getSnapshot()).thumbs).toEqual([]);
        yield* sink.write({ events: [output(ownId), taskEvent(ownTask)] });
        expect((yield* (yield* Rankings.SubagentRankings).getSnapshot()).thumbs).toEqual([
          { taskId: ownTask.id },
        ]);
      }
      const fixed = { ...ownTask, status: "completed" as const };
      yield* sink.write({ events: [taskEvent(fixed)] });
      const saved = yield* decodeState(
        yield* fs.readFileString(`${config.stateDir}/subagent-rankings.json`),
      );
      expect(saved.runs).toMatchObject([
        {
          taskId: ownTask.id,
          instanceId: ProviderInstanceId.make("actual-provider"),
          model: "actual-model",
          fixRounds: 2,
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.each([
  { message: "Claude gave up after repeated API errors.", code: null },
  { message: "Provider unavailable", code: "retry_exhausted" },
  { message: "Provider unavailable", code: "api_error" },
  { message: "Provider unavailable", code: "503" },
  { message: "Provider unavailable", code: "http_502" },
  { message: "Request failed with status code 500", code: null },
  { message: 'API Error: 529 {"type":"overloaded_error"}', code: null },
  { message: "Overloaded", code: null },
])("omits a provider outage without assistant output: %j", (details) => {
  const metadata = {
    isolated: false,
    fixRounds: 0,
    providerFailure: { ...modelFault, ...details },
  };
  expect(
    terminalRunRecord(task({ status: "failed" }), { ...metadata, hasAssistantOutput: false }),
  ).toBeUndefined();
  expect(
    terminalRunRecord(task({ status: "failed" }), { ...metadata, hasAssistantOutput: true })
      ?.outcome,
  ).toBe("failed");
  expect(terminalRunRecord(task(), { ...metadata, hasAssistantOutput: false })?.outcome).toBe(
    "completed",
  );
});

it("leaves out failures outside the model: filters, workspace setup, harness crashes", () => {
  const record = (failure: Partial<typeof modelFault>, hasAssistantOutput: boolean) =>
    terminalRunRecord(task({ status: "failed" }), {
      isolated: false,
      fixRounds: 0,
      hasAssistantOutput,
      providerFailure: { ...modelFault, ...failure },
    });
  for (const failure of [
    {
      class: "provider_error",
      code: "other",
      message:
        "Invalid prompt: your prompt was flagged as potentially violating our usage policy. Please try again with a different prompt",
    },
    {
      class: "validation_error",
      code: "workspace_preparation_failed",
      message: "Workspace preparation failed during provision worktree: Git command failed",
    },
  ] as const) {
    expect(isInfrastructureFailure({ ...modelFault, ...failure }, true)).toBe(true);
    expect(record(failure, true)).toBeUndefined();
  }
  const crash = { class: "provider_error", code: "-32603", message: "Internal error" } as const;
  expect(record(crash, false)).toBeUndefined();
  // Once the model has answered, an internal error may be its own doing.
  expect(record(crash, true)?.outcome).toBe("failed");
});

it("keeps model failures that merely mention repeated work or error-like numbers", () => {
  for (const message of [
    "The model repeated an invalid tool call",
    "Unexpected token at position 503",
    "Tool output exceeded 5030 lines",
  ])
    expect(
      terminalRunRecord(task({ status: "failed" }), {
        isolated: false,
        fixRounds: 0,
        hasAssistantOutput: false,
        providerFailure: { ...modelFault, message },
      })?.outcome,
    ).toBe("failed");
});

it("omits council members by their generated task or child title", () => {
  expect(
    terminalRunRecord(task({ title: "Council: gpt-6.1-sol" }), {
      isolated: false,
      fixRounds: 0,
    }),
  ).toBeUndefined();
  expect(
    terminalRunRecord(task({ title: null }), {
      isolated: false,
      fixRounds: 0,
      title: "Council: claude-opus-5-5",
    }),
  ).toBeUndefined();
});

it.effect(
  "records no run for follow-ups to an existing child but ranks their grades on its original run",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const rankings = yield* Rankings.SubagentRankings;
      const original = task();
      yield* sink.write({
        events: [parentId, childId].map((id) => ({
          id: EventId.make(`followup-thread-${id}`),
          type: "thread.created" as const,
          threadId: id,
          occurredAt: at,
          payload: {
            ...thread(id),
            forkedFrom: id === childId ? { type: "node" as const, nodeId: original.id } : null,
          },
        })),
      });
      yield* sink.write({ events: [taskEvent(original)] });
      yield* sink.write({ events: [taskEvent(task({ id: NodeId.make("followup") }))] });
      yield* sink.write({
        events: [
          taskEvent({
            ...original,
            completionDelivery: { state: "acknowledged", observedByRunId: null },
          }),
        ],
      });
      // Rankings read only runs in their window; move the test clock past the run.
      yield* TestClock.setTime(DateTime.toEpochMillis(finish) + 60_000);
      const before = yield* rankings.getSnapshot();
      expect(before.thumbs.map((run) => run.taskId)).toEqual([original.id]);
      const followup = NodeId.make("followup");
      yield* rankings.gradeMany([{ taskId: followup, runTaskId: original.id, score: 3 }]);
      const after = yield* rankings.getSnapshot();
      expect(after.thumbs).toContainEqual({ taskId: followup, grade: 3 });
      // The follow-up's flag counts against the run it continued, which stays one run.
      expect(after.models[0]!.stats?.runs).toBe(before.models[0]!.stats?.runs);
      expect(after.models[0]!.yourRuns).toContain("low grades 1/1");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("attaches a follow-up grade an earlier build left waiting to its original run", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const rankings = yield* Rankings.SubagentRankings;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const original = task();
    const followup = task({ id: NodeId.make("waiting-followup") });
    yield* sink.write({
      events: [parentId, childId].map((id) => ({
        id: EventId.make(`waiting-thread-${id}`),
        type: "thread.created" as const,
        threadId: id,
        occurredAt: at,
        payload: {
          ...thread(id),
          forkedFrom: id === childId ? { type: "node" as const, nodeId: original.id } : null,
        },
      })),
    });
    yield* sink.write({ events: [taskEvent(original)] });
    yield* sink.write({ events: [taskEvent(followup)] });
    // Earlier builds saved a follow-up's grade without naming its original run.
    yield* rankings.gradeMany([
      { taskId: followup.id, score: 4 },
      { taskId: NodeId.make("never-ran"), score: 7 },
    ]);
    // The startup pass runs once the server has settled; its grade then ranks the original.
    const ranked = yield* rankings.subscribe().pipe(
      Stream.filter((snapshot) => snapshot.models.some((model) => (model.stats?.rated ?? 0) > 0)),
      Stream.runHead,
      Effect.forkScoped,
    );
    yield* TestClock.setTime(DateTime.toEpochMillis(finish) + 60_000);
    expect(Option.getOrThrow(yield* Fiber.join(ranked)).models[0]!.stats).toMatchObject({
      rated: 1,
      average: 4,
    });
    const saved = yield* decodeState(
      yield* fs.readFileString(`${config.stateDir}/subagent-rankings.json`),
    );
    // The follow-up's own completion was recorded on the original run as it finished.
    expect(saved.runs.map((run) => [run.taskId, run.followUps])).toEqual([
      [
        original.id,
        [
          {
            taskId: followup.id,
            outcome: "completed",
            finishedAt: DateTime.toEpochMillis(finish),
            grade: { score: 4 },
          },
        ],
      ],
    ]);
    expect(saved.pendingGrades).toEqual([{ taskId: "never-ran", score: 7 }]);
    // Startup also records follow-ups that completed before completions were kept.
    expect(yield* completedFollowUpsSince(DateTime.toEpochMillis(at))).toEqual([
      {
        taskId: followup.id,
        runTaskId: original.id,
        outcome: "completed",
        finishedAt: DateTime.toEpochMillis(finish),
      },
    ]);
    expect(yield* completedFollowUpsSince(DateTime.toEpochMillis(finish) + 1)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
