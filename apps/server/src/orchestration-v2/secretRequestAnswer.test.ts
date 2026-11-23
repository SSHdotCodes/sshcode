import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  RuntimeRequestId,
  SECRET_REQUEST_TURN_ITEM_ID_PREFIX,
  TurnItemId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { secretRequestAnswerCommand } from "./secretRequestAnswer.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const decodeEffectRequest = Schema.decodeSync(EffectOutbox.OrchestrationEffectRequestV2);

it.each([
  { handle: "secret-ref:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", detail: "secretRef:" },
  { handle: "/private/tmp/private-secret-file", detail: "File:" },
])("keeps $detail in the agent message and out of the chat row", ({ handle, detail }) => {
  const summary = 'The user saved "Gemini v2.5 key".';
  const text = `${summary} ${detail} ${handle}`;
  const command = secretRequestAnswerCommand(ThreadId.make("thread"), {
    type: "secret-request.answered",
    turnItemId: TurnItemId.make("card"),
    text,
    summary,
  });
  assert.equal(command.text, text);
  assert.equal(command.notification.summary, summary);
  assert.notInclude(command.notification.summary, handle);
});

it("decodes an older outbox row without exposing its handle in the summary", () => {
  const request = decodeEffectRequest({
    type: "secret-request.answered",
    turnItemId: "card",
    text: 'The user saved "API key". File: /private/tmp/private-secret-file',
  });
  assert.equal(request.type, "secret-request.answered");
  if (request.type !== "secret-request.answered") return;
  const command = secretRequestAnswerCommand(ThreadId.make("thread"), request);
  assert.equal(command.text, request.text);
  assert.equal(command.notification.summary, "Secret request answered.");
  assert.notInclude(command.notification.summary, "/private/tmp/private-secret-file");
});

it.live.each([
  { status: "saved", ended: false },
  { status: "declined", ended: false },
  { status: "saved", ended: true },
  { status: "declined", ended: true },
] as const)(
  "durably delivers $status once after restart (asking run ended: $ended)",
  ({ status, ended }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "secret-notice-restart-" });
      const threadId = ThreadId.make("thread:secret-subagent");
      const turnItemId = TurnItemId.make(`${SECRET_REQUEST_TURN_ITEM_ID_PREFIX}secret-card`);
      const effectId = `effect:secret-request-answer:${turnItemId}`;
      // Each phase closes and rebuilds all services and the database connection.
      const freshRuntime = () => {
        const database = SqlitePersistence.layerFromPath(`${directory}/state.sqlite`).pipe(
          Layer.provide(NodeServices.layer),
        );
        return Layer.mergeAll(
          ProjectionStore.layer.pipe(Layer.provide(database)),
          EffectOutbox.layer.pipe(Layer.provide(database)),
          ProviderReplayHarness.layerWithRegistry(
            { name: "secret-notices" },
            ProviderAdapterRegistry.layerFromAdapters([adapter]),
            { databaseLayer: database, runEffectWorker: false },
          ),
        );
      };
      yield* Effect.gen(function* () {
        const engine = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:secret"),
          title: "Subagent",
          modelSelection: { instanceId, model: "gpt-5.1-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* engine.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("start"),
          threadId,
          messageId: MessageId.make("start"),
          text: "Work",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const run = (yield* projections.getThreadRecords(threadId, ["runs"])).runs[0]!;
        const record = {
          type: "secret_request.record" as const,
          threadId,
          runId: run.id,
          nodeId: run.rootNodeId!,
          turnItemId,
          label: "API key",
          reason: "Needed later",
        };
        yield* engine.dispatch({
          ...record,
          commandId: CommandId.make("ask"),
          secretStatus: "pending",
        });
        if (ended) {
          const requestId = RuntimeRequestId.make("async-question");
          yield* engine.dispatch({
            type: "user_question.ask",
            commandId: CommandId.make("question"),
            threadId,
            runId: run.id,
            nodeId: run.rootNodeId!,
            requestId,
            turnItemId: TurnItemId.make("question"),
            questions: [
              {
                id: "q",
                header: "Question",
                question: "Which target?",
                options: [],
                allowCustomAnswer: true,
                waitsForUser: true,
              },
            ],
          });
          yield* engine.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("interrupt"),
            threadId,
            runId: run.id,
          });
          const card = (yield* projections.getThreadRecords(threadId, [
            "turnItems",
          ])).turnItems.find((item) => item.id === turnItemId);
          assert.isTrue(card?.type === "secret_request" && card.secretStatus === "pending");
          const requests = (yield* projections.getThreadRecords(threadId, ["runtimeRequests"]))
            .runtimeRequests;
          assert.equal(requests.find((request) => request.id === requestId)?.status, "pending");
        }
        const text =
          status === "saved"
            ? 'The user saved "API key". secretRef: secret-ref:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
            : 'The user declined "API key".';
        yield* engine.dispatch({
          ...record,
          commandId: CommandId.make("answer"),
          secretStatus: status,
          answerNotice: text,
          answerNoticeSummary: status === "saved" ? 'The user saved "API key".' : text,
        });
        yield* engine.dispatch({
          ...record,
          commandId: CommandId.make("answer-again"),
          secretStatus: status,
          answerNotice: text,
          answerNoticeSummary: status === "saved" ? 'The user saved "API key".' : text,
        });
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const effect = Option.getOrThrow(yield* outbox.get(effectId));
        assert.equal(effect.status, "pending");
        assert.lengthOf((yield* projections.getThreadRecords(threadId, ["messages"])).messages, 1);
      }).pipe(Effect.provide(freshRuntime()));
      for (let restart = 0; restart < 2; restart++) {
        yield* Effect.gen(function* () {
          const outbox = yield* EffectOutbox.EffectOutboxV2;
          yield* outbox.reconcileAfterProcessLoss;
          const effect = Option.getOrThrow(yield* outbox.get(effectId));
          assert.equal(effect.request.type, "secret-request.answered");
          if (effect.request.type !== "secret-request.answered") return;
          assert.equal(
            effect.request.summary,
            status === "saved" ? 'The user saved "API key".' : effect.request.text,
          );
          const engine = yield* Orchestrator.OrchestratorV2;
          yield* engine.dispatch(secretRequestAnswerCommand(threadId, effect.request));
          yield* engine.dispatch(secretRequestAnswerCommand(threadId, effect.request));
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const { messages, runs, turnItems } = yield* projections.getThreadRecords(threadId, [
            "messages",
            "runs",
            "turnItems",
          ]);
          const notices = messages.filter((message) => message.notification !== undefined);
          assert.lengthOf(notices, 1);
          assert.equal(notices[0]!.notification?.source.kind, "system");
          assert.equal(notices[0]!.notification?.summary, effect.request.summary);
          assert.notInclude(notices[0]!.notification!.summary, "secret-ref:");
          assert.equal(notices[0]!.createdBy, "agent");
          assert.equal(
            runs.find((run) => run.userMessageId === notices[0]!.id)?.status,
            ended ? "starting" : "queued",
          );
          // Queued notices acquire their timeline row when their run starts.
          if (ended) assert.isTrue(turnItems.some((item) => item.type === "notification"));
        }).pipe(Effect.provide(freshRuntime()));
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("secret_request.record rejects off-prefix turn item ids and indexes prefixed cards", () =>
  Effect.gen(function* () {
    const database = SqlitePersistence.layerMemory;
    const runtime = Layer.mergeAll(
      ProjectionStore.layer.pipe(Layer.provide(database)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "secret-request-prefix" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: database, runEffectWorker: false },
      ),
    );
    yield* Effect.gen(function* () {
      const engine = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:secret-prefix");
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-prefix"),
        threadId,
        projectId: ProjectId.make("project:secret-prefix"),
        title: "Secret prefix",
        modelSelection: { instanceId, model: "gpt-5.1-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* engine.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("start-prefix"),
        threadId,
        messageId: MessageId.make("start-prefix"),
        text: "Work",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const run = (yield* projections.getThreadRecords(threadId, ["runs"])).runs[0]!;

      const rejected = yield* engine
        .dispatch({
          type: "secret_request.record",
          commandId: CommandId.make("ask-off-prefix"),
          threadId,
          runId: run.id,
          nodeId: run.rootNodeId!,
          turnItemId: TurnItemId.make("off-prefix-secret-card"),
          label: "API key",
          reason: "Should be rejected",
          secretStatus: "pending",
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(rejected));

      const prefixedId = TurnItemId.make(`${SECRET_REQUEST_TURN_ITEM_ID_PREFIX}valid-card`);
      yield* engine.dispatch({
        type: "secret_request.record",
        commandId: CommandId.make("ask-prefixed"),
        threadId,
        runId: run.id,
        nodeId: run.rootNodeId!,
        turnItemId: prefixedId,
        label: "API key",
        reason: "Valid prefixed card",
        secretStatus: "pending",
      });

      const found = (yield* projections.getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["secret_request"],
      })).turnItems;
      assert.deepEqual(
        found.map((item) => item.id),
        [prefixedId],
      );
    }).pipe(Effect.provide(runtime));
  }),
);
