import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { makeTestAdapter, type CapturedTurn } from "./testkit/ProviderSwitch.testkit.ts";

const sender = ThreadId.make("peer-sender");
const target = ThreadId.make("peer-target");
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "fixture-model" };
const messageId = MessageId.make("peer-send");

it.live.each(["live", "archived", "deleted"] as const)(
  "recovers a peer run and checks its %s sender before delivering the result",
  (state) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("peer-completion");
        const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
        const database = SqlitePersistence.layerFromPath(`${directory}/state.sqlite`).pipe(
          Layer.provide(NodeServices.layer),
        );
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const adapter = makeTestAdapter({
          driver: ProviderDriverKind.make("codex"),
          instanceId: selection.instanceId,
          capabilities: CodexProviderCapabilitiesV2,
          modelSelection: selection,
          capturedTurns,
          responseByRunOrdinal: { 2: "Recovered final reply." },
        });
        const runtime = (recoverOnStartup: boolean) =>
          ProviderReplayHarness.layerWithRegistry(
            { name: "peer-completion-restart", runtimePolicyOverride: { cwd } },
            ProviderAdapterRegistry.layerFromAdapters([adapter]),
            {
              databaseLayer: database,
              runEffectWorker: recoverOnStartup,
              recoverOnStartup,
              continueThreadsAfterServerUpdate: true,
            },
          );

        // Close the first server with the message committed, before its provider starts.
        const sourceRunId = yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          for (const threadId of [sender, target]) {
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make(`create:${threadId}`),
              threadId,
              title: threadId,
              projectId: ProjectId.make("peers"),
              modelSelection: selection,
              runtimeMode: "full-access",
              interactionMode: "default",
              createdBy: "user",
              creationSource: "web",
              branch: null,
              worktreePath: cwd,
            });
          }
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("send"),
            threadId: target,
            messageId,
            senderThreadId: sender,
            notifySenderOnCompletion: true,
            text: "Report the result.",
            attachments: [],
            createdBy: "agent",
            creationSource: "mcp",
            dispatchMode: { type: "start_immediately" },
          });
          if (state !== "live") {
            yield* orchestrator.dispatch({
              type: state === "archived" ? "thread.archive" : "thread.delete",
              commandId: CommandId.make(state),
              threadId: sender,
            });
          }
          return (yield* orchestrator.getThreadProjection(target)).runs[0]!.id;
        }).pipe(Effect.provide(runtime(false)));

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const awaitCompletion = (threadId: ThreadId) =>
            orchestrator
              .streamStoredEventsFrom({
                threadId,
                eventType: "run.updated",
                afterSequence: 0,
              })
              .pipe(
                Stream.filter(
                  ({ event }) =>
                    event.type === "run.updated" && event.payload.status === "completed",
                ),
                Stream.take(1),
                Stream.runDrain,
              );
          yield* awaitCompletion(target);
          if (state === "live") yield* awaitCompletion(sender);
          yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
          const runs = (yield* orchestrator.getThreadProjection(target)).runs;
          assert.equal(runs.length, 2);
          assert.equal(runs[1]?.restartContinuationOfRunId, sourceRunId);
          const prompts = (yield* Ref.get(capturedTurns)).filter(
            (turn) => turn.threadId === sender,
          );
          assert.deepEqual(
            prompts.map((turn) => turn.text),
            state === "live" ? [`Thread ${target} run 2 completed\nRecovered final reply.`] : [],
          );
        }).pipe(Effect.provide(runtime(true)));

        if (state !== "live") return;
        // Model a crash after the recipient's dispatch committed but before the worker acknowledged it.
        // Drive recovery and replay to completion with the background worker stopped.
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const replay = yield* sql`
            UPDATE orchestration_v2_effect_outbox SET status = 'running'
            WHERE effect_type = 'thread-send.complete' AND status = 'succeeded'
            RETURNING effect_id
          `;
          assert.isNotEmpty(replay);
          const outbox = yield* EffectOutbox.EffectOutboxV2;
          assert.equal((yield* outbox.reconcileAfterProcessLoss).requeued, replay.length);
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          assert.isAtLeast(yield* worker.drain(), replay.length);
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          assert.lengthOf((yield* orchestrator.getThreadProjection(sender)).runs, 1);
          assert.lengthOf(
            (yield* Ref.get(capturedTurns)).filter((turn) => turn.threadId === sender),
            1,
          );
        }).pipe(
          Effect.provide(
            Layer.merge(runtime(false), EffectOutbox.layer.pipe(Layer.provideMerge(database))),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);
