import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProviderDriverKind,
  type OrchestrationV2DomainEvent,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlError from "effect/sql/SqlError";
import * as TestClock from "effect/testing/TestClock";
import { ClaudeOrchestratorReplayHarness } from "../Adapters/ClaudeAdapterV2.testkit.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as EventStore from "../EventStore.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderSessionManager from "../ProviderSessionManager.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { layerProviderReplay } from "./ProviderReplayHarness.ts";
import { CLAUDE_MODEL_SELECTION, materializeFixtureInput } from "./fixtures/shared.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const sessionId = "native-claude-storage-replay";
const prompt = "Inspect the workspace.";
const materialized = (name: string) =>
  materializeFixtureInput({
    scenario: name,
    fixtureInput: { steps: [{ type: "message", text: prompt }] },
    driver,
    modelSelection: CLAUDE_MODEL_SELECTION,
  }).pipe(Effect.provide(IdAllocator.layer));

const tool = (id: string, label?: string) =>
  [
    {
      type: "emit_inbound",
      ...(label === undefined ? {} : { label }),
      frame: {
        type: "assistant",
        uuid: `assistant-${id}`,
        session_id: sessionId,
        parent_tool_use_id: null,
        message: {
          id: `message-${id}`,
          model: "claude-sonnet-4-6",
          role: "assistant",
          content: [{ type: "tool_use", id, name: "Bash", input: { command: "pwd" } }],
        },
      },
    },
    {
      type: "emit_inbound",
      frame: {
        type: "user",
        uuid: `result-${id}`,
        session_id: sessionId,
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
        },
      },
    },
  ] satisfies ProviderReplayTranscript["entries"];

const result = {
  type: "result",
  subtype: "success",
  uuid: "turn-result",
  session_id: sessionId,
  stop_reason: "end_turn",
  terminal_reason: "completed",
  num_turns: 3,
  is_error: false,
  result: "Finished checking.",
  usage: { input_tokens: 13, output_tokens: 7 },
};

const opener = [
  {
    type: "expect_outbound",
    frame: {
      type: "query.open",
      options: {
        model: "claude-sonnet-4-6",
        tools: { type: "preset", preset: "claude_code" },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        sessionId,
      },
    },
  },
  {
    type: "expect_outbound",
    frame: {
      type: "prompt.offer",
      message: {
        type: "user",
        message: { role: "user", content: prompt },
        parent_tool_use_id: null,
      },
    },
  },
] satisfies ProviderReplayTranscript["entries"];

const isToolUpdate = (event: OrchestrationV2DomainEvent, id: string) =>
  event.type === "turn-item.updated" && event.payload.nativeItemRef?.nativeId === id;

const cantOpen = new EventStore.EventStoreAppendEventsError({
  eventCount: 1,
  cause: new SqlError.SqlError({
    reason: new SqlError.ConnectionError({
      cause: { code: "ERR_SQLITE_ERROR", errcode: 14, message: "unable to open database file" },
    }),
  }),
});

const steerText = "Check one more file.";

it.effect.each(["transient", "transaction defect", "sustained"] as const)(
  "settles a Claude turn after a %s event storage outage",
  (outage) =>
    Effect.gen(function* () {
      const sustained = outage === "sustained";
      const name = `claude-event-storage-${outage.replaceAll(" ", "-")}`;
      const replayGate = makeProviderReplayGate(["middle", "before-result"]);
      const appendFailed = yield* Deferred.make<void>();
      const settlementFailed = yield* Deferred.make<void>();
      let unavailable = true;
      let failedAppends = 0;
      const eventStoreLayer = Layer.effect(
        EventStore.EventStoreV2,
        Effect.gen(function* () {
          const store = yield* EventStore.EventStoreV2;
          return EventStore.EventStoreV2.of({
            ...store,
            append: (input) =>
              Effect.gen(function* () {
                const settlesFailure = input.events.some(
                  (event) => event.type === "run.updated" && event.payload.status === "failed",
                );
                if (
                  !unavailable ||
                  (!input.events.some((event) => isToolUpdate(event, "middle-tool")) &&
                    !settlesFailure)
                ) {
                  return yield* store.append(input);
                }
                failedAppends++;
                if (!sustained && failedAppends === 2) unavailable = false;
                yield* Deferred.succeed(appendFailed, undefined);
                if (settlesFailure) yield* Deferred.succeed(settlementFailed, undefined);
                if (outage === "transaction defect") {
                  // The append ran inside the sink's transaction. It must
                  // roll back so the retry leaves one copy of the event.
                  yield* store.append(input);
                  return yield* Effect.die(cantOpen);
                }
                return yield* Effect.fail(cantOpen);
              }),
          });
        }),
      ).pipe(Layer.provide(EventStore.layer));
      const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript({
        provider: driver,
        protocol: "claude-agent-sdk.query",
        version: "1",
        scenario: name,
        metadata: { nativeSessionId: sessionId },
        entries: [
          ...opener,
          ...tool("first-tool"),
          ...tool("middle-tool", "middle"),
          ...tool("later-tool"),
          {
            type: "expect_outbound",
            frame: sustained
              ? { type: "query.interrupt" }
              : {
                  type: "prompt.offer",
                  message: {
                    type: "user",
                    message: { role: "user", content: steerText },
                    priority: "next",
                    parent_tool_use_id: null,
                  },
                },
          },
          { type: "emit_inbound", ...(sustained ? {} : { label: "before-result" }), frame: result },
        ],
      });
      const scenario = { name, transcript, ...(yield* materialized(name)) };
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const threadId = scenario.projectionThreadIds[0]!;
        const stored = () => orchestrator.streamStoredEventsFrom({ threadId });
        const waitFor = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          stored().pipe(
            Stream.filter(({ event }) => predicate(event)),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          );
        for (const command of scenario.commands) yield* orchestrator.dispatch(command);
        yield* worker.drain();
        yield* waitFor((event) => isToolUpdate(event, "first-tool"));
        const before = yield* orchestrator.getThreadProjection(threadId);
        const run = before.runs[0]!;
        const providerThread = before.providerThreads[0]!;
        const providerTurn = before.providerTurns[0]!;
        const runtime = Option.getOrThrow(yield* sessions.get(providerThread.providerSessionId!));
        replayGate.release("middle");
        yield* Deferred.await(appendFailed);
        if (sustained) {
          yield* TestClock.adjust("92 seconds");
          yield* Deferred.await(settlementFailed);
          const rejected = yield* runtime
            .steerTurn({
              threadId,
              runId: run.id,
              providerThread,
              providerTurnId: providerTurn.id,
              message: {
                messageId: MessageId.make("storage-replay-late-steer"),
                text: steerText,
                attachments: [],
                createdBy: "user",
                creationSource: "web",
              },
            })
            .pipe(Effect.flip);
          assert.match(String(rejected), /steer/i);
          unavailable = false;
          yield* TestClock.adjust("30 seconds");
          yield* waitFor(
            (event) => event.type === "run.updated" && event.payload.status === "failed",
          );
          const after = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(after.providerTurns[0]?.status, "failed");
          assert.isTrue(
            after.turnItems.some(
              (item) =>
                item.type === "error" &&
                item.failure.message.includes("could not save the conversation"),
            ),
          );
          return;
        }
        yield* TestClock.adjust("3 seconds");
        yield* waitFor(
          (event) =>
            event.type === "turn-item.updated" &&
            isToolUpdate(event, "later-tool") &&
            event.payload.status === "completed",
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("storage-replay-steer"),
          threadId,
          messageId: MessageId.make("storage-replay-steer"),
          text: steerText,
          attachments: [],
          dispatchMode: { type: "steer_active", targetRunId: run.id },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        assert.isTrue(yield* Effect.promise(() => replayGate.waitForReached("before-result")));
        replayGate.release("before-result");
        const events = yield* stored().pipe(
          Stream.takeUntil(
            ({ event }) => event.type === "run.updated" && event.payload.status === "waiting",
          ),
          Stream.runCollect,
        );
        assert.deepEqual(
          events.flatMap(({ event }) => {
            if (event.type !== "turn-item.updated" || event.payload.type !== "command_execution")
              return [];
            return [[event.payload.nativeItemRef?.nativeId, event.payload.status]];
          }),
          [
            ["first-tool", "running"],
            ["first-tool", "completed"],
            ["middle-tool", "running"],
            ["middle-tool", "completed"],
            ["later-tool", "running"],
            ["later-tool", "completed"],
          ],
        );
        assert.equal(failedAppends, 2);
        yield* worker.drain();
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.runs[0]?.status, "completed");
        assert.equal(after.providerTurns[0]?.status, "completed");
        assert.deepInclude(after.providerTurns[0]?.turnTokenUsage, {
          usageStatus: "complete",
          inputTokens: 13,
          outputTokens: 7,
        });
      }).pipe(
        Effect.provide(
          layerProviderReplay(scenario, ClaudeOrchestratorReplayHarness, {
            eventStoreLayer,
            replayGate,
            runEffectWorker: false,
          }),
        ),
        Effect.scoped,
      );
    }).pipe(provideDeterministicTestRuntime),
);
