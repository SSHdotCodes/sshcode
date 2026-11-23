import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
const instanceId = ProviderInstanceId.make("codex_work");
const modelSelection = { instanceId, model: "gpt-6.1-sol" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("test never launches providers"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const testLayer = (scope: "project" | "account") => {
  const settings = ServerSettings.layerTest({
    providerInstances: {
      [ProviderInstanceId.make("codex")]: {
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
      },
      [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: scope !== "account" },
    },
    projectSettingsOverrides:
      scope === "project"
        ? {
            [ProjectId.make("project:multi-choice-answer")]: {
              providerInstances: { [instanceId]: { enabled: false } },
            },
          }
        : {},
  }).pipe(Layer.orDie);
  const orchestration = ProviderReplayHarness.layerWithRegistry(
    { name: "disabled-account-question" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false, serverSettingsLayer: settings },
  );
  const management = ThreadManagement.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        orchestration,
        settings,
        CommandReceiptStore.layer.pipe(Layer.provide(database)),
      ),
    ),
  );
  return Layer.mergeAll(
    database,
    orchestration,
    management,
    settings,
    CommandReceiptStore.layer.pipe(Layer.provide(database)),
    ProjectionStore.layer.pipe(Layer.provide(database)),
  );
};

it.effect.each(["project", "account"] as const)(
  "answering a question cannot start a disabled account (%s)",
  (scope) =>
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

      const threads = yield* ThreadManagement.ThreadManagementService;
      const ordinary = yield* Effect.exit(
        threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("ordinary-send-disabled"),
          threadId,
          messageId: MessageId.make("ordinary-send-disabled"),
          text: "synthetic follow-up",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        }),
      );
      assert.equal(ordinary._tag, "Failure");
      const answerCommand = {
        type: "runtime-request.respond" as const,
        commandId: CommandId.make("respond-multi-choice-answer"),
        threadId,
        requestId,
        answers: { q1: ["Old runs (~31 GB)", "Hunt folders, raw + extracted"] },
      };
      const answer = yield* Effect.exit(threads.dispatch(answerCommand));
      assert.equal(answer._tag, "Failure");
      if (answer._tag !== "Failure" || ordinary._tag !== "Failure") return;
      const error = Cause.squash(answer.cause);
      assert.instanceOf(error, ThreadManagement.ThreadManagementProviderInstanceDisabledError);
      assert.equal(String(error), String(Cause.squash(ordinary.cause)));

      const projection = yield* projections.getThreadProjection(threadId);
      assert.deepEqual(projection.runs, []);
      assert.deepEqual(projection.messages, []);
      assert.equal(projection.runtimeRequests[0]?.status, "pending");
      assert.equal(projection.nodes.find((node) => node.id === nodeId)?.status, "waiting");
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      assert.isTrue(Option.isNone(yield* receipts.getByCommandId(answerCommand.commandId)));
      // The same delivery can succeed once the account is enabled.
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({
        providerInstances: {
          [ProviderInstanceId.make("codex")]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
            config: {},
          },
          [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true, config: {} },
        },
        projectSettingsOverrides: {
          [ProjectId.make("project:multi-choice-answer")]: {
            providerInstances: { [instanceId]: { enabled: true } },
          },
        },
      });
      yield* threads.dispatch(answerCommand);
      const enabled = yield* projections.getThreadProjection(threadId);
      assert.equal(enabled.runtimeRequests[0]?.status, "resolved");
      assert.equal(enabled.runs[0]?.providerInstanceId, instanceId);
    }).pipe(Effect.provide(testLayer(scope))),
);
