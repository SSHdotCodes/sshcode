import { assert, it } from "@effect/vitest";
import { ANTIGRAVITY_DEFAULT_MODEL, type ProviderReplayEntry } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as Effect from "effect/Effect";

import { driver, harness, instanceId, reply, request } from "./testkit/AntigravityReplayHarness.ts";
import { provideDeterministicTestRuntime } from "./testkit/DeterministicRuntime.ts";
import { runOrchestratorV2ProviderReplayScenario } from "./testkit/ProviderReplayHarness.ts";
import { materializeFixtureInput } from "./testkit/fixtures/shared.ts";

const update = (update: unknown, label?: string): ProviderReplayEntry => ({
  type: "emit_inbound",
  ...(label === undefined ? {} : { label }),
  frame: {
    kind: "notification",
    method: "session/update",
    params: { sessionId: "antigravity-session", update },
  },
});
const chunk = (text: string) =>
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

it.effect("delivers a queued message after Antigravity's native timer ends", () =>
  Effect.gen(function* () {
    const name = "antigravity-queue-during-timer";
    const cwd = yield* checkpointWorkspace(name);
    const transcript = yield* harness.decodeTranscript({
      provider: driver,
      protocol: "acp.ndjson-jsonrpc",
      version: "1",
      scenario: name,
      entries: [
        request("initialize"),
        reply("initialize", {
          protocolVersion: 1,
          agentInfo: { name: "agy", version: "1.5.16" },
          agentCapabilities: { loadSession: false },
          authMethods: [],
        }),
        request("session/new"),
        reply("session/new", {
          sessionId: "antigravity-session",
          modes: { currentModeId: "yolo", availableModes: [{ id: "yolo", name: "Full access" }] },
        }),
        request("session/prompt"),
        update({
          sessionUpdate: "tool_call",
          toolCallId: "timer",
          kind: "other",
          title: "Run schedule",
          status: "in_progress",
          rawInput: { DurationSeconds: 1800, Prompt: "Check progress" },
        }),
        update(
          { sessionUpdate: "tool_call_update", toolCallId: "timer", status: "completed" },
          "timer-fired",
        ),
        chunk("The timer fired."),
        reply("session/prompt", { stopReason: "end_turn" }),
        request("session/prompt"),
        chunk("I received the follow-up."),
        reply("session/prompt", { stopReason: "end_turn" }),
      ],
    });
    const materialized = yield* materializeFixtureInput({
      scenario: name,
      driver,
      modelSelection: { instanceId, model: ANTIGRAVITY_DEFAULT_MODEL },
      fixtureInput: {
        steps: [
          { type: "message", text: "Check the rollouts in 30 minutes." },
          { type: "queue_message", text: "Check the relay too.", creationSource: "mobile" },
        ],
      },
    }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
    const threadId = materialized.projectionThreadIds[0]!;
    const result = yield* runOrchestratorV2ProviderReplayScenario(
      {
        name,
        transcript,
        commands: materialized.commands,
        steps: materialized.steps.flatMap((step) =>
          step.type === "dispatch" &&
          step.command.type === "message.dispatch" &&
          step.command.dispatchMode?.type === "queue_after_active"
            ? [step, { type: "release_replay_gate" as const, label: "timer-fired" }]
            : [step],
        ),
        projectionThreadIds: [threadId],
        runtimePolicyOverride: { cwd },
      },
      harness,
    ).pipe(provideDeterministicTestRuntime);
    const projection = result.projections.get(threadId)!;
    assert.deepEqual(
      projection.runs.map((run) => run.status),
      ["completed", "completed"],
    );
    const [firstRun, queuedRun] = projection.runs;
    assert.isDefined(firstRun);
    assert.isDefined(queuedRun);
    const queued = projection.turnItems.find(
      (item) => item.type === "user_message" && item.runId === queuedRun.id,
    );
    assert.include(queued, {
      status: "completed",
      inputIntent: "queued_turn",
      text: "Check the relay too.",
    });
    const timer = projection.turnItems.find((item) => item.nativeItemRef?.nativeId === "timer");
    assert.include(timer, { status: "completed", runId: firstRun.id });
    assert.deepEqual(projection.providerThreads[0]?.pendingBackgroundTasks, []);
  }).pipe(Effect.scoped),
);

it.effect.each(
  [false, true].flatMap((native) =>
    (["auto", "steer"] as const).map((intent) => ({ native, intent }) as const),
  ),
)(
  "delivers Antigravity $intent through its negotiated steering strategy (native=$native)",
  ({ native, intent }) =>
    Effect.gen(function* () {
      const name = `antigravity-steering-${intent}-${native}`;
      const cwd = yield* checkpointWorkspace(name);
      const transcript = yield* harness.decodeTranscript({
        provider: driver,
        protocol: "acp.ndjson-jsonrpc",
        version: "1",
        scenario: name,
        entries: [
          request("initialize"),
          reply("initialize", {
            protocolVersion: 1,
            agentCapabilities: { loadSession: false },
            authMethods: [],
            ...(native ? { _meta: { steering: { supported: true } } } : {}),
          }),
          request("session/new"),
          reply("session/new", {
            sessionId: "antigravity-session",
            modes: { currentModeId: "yolo", availableModes: [{ id: "yolo", name: "Full access" }] },
          }),
          request("session/prompt"),
          chunk("working"),
          ...(native
            ? [
                {
                  type: "expect_outbound" as const,
                  frame: {
                    kind: "request",
                    method: "_session/steering",
                    params: {
                      sessionId: "antigravity-session",
                      prompt: [{ type: "text", text: "new direction" }],
                      _meta: { steering: { idleBehavior: "promptRequired" } },
                    },
                  },
                },
                reply("_session/steering", { outcome: "injected" }),
                chunk("steered answer"),
                reply("session/prompt", { stopReason: "end_turn" }),
              ]
            : [
                {
                  type: "expect_outbound" as const,
                  frame: {
                    kind: "notification",
                    method: "session/cancel",
                    params: { sessionId: "antigravity-session" },
                  },
                },
                reply("session/prompt", { stopReason: "cancelled" }),
                request("session/prompt"),
                chunk("resent answer"),
                reply("session/prompt", { stopReason: "end_turn" }),
              ]),
        ],
      });
      const materialized = yield* materializeFixtureInput({
        scenario: name,
        driver,
        modelSelection: { instanceId, model: ANTIGRAVITY_DEFAULT_MODEL },
        fixtureInput: {
          steps: [
            { type: "message", text: "original" },
            { type: "steer", text: "new direction", targetRunIndex: 1 },
          ],
        },
      }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
      const result = yield* runOrchestratorV2ProviderReplayScenario(
        {
          name,
          transcript,
          commands: materialized.commands.map((command) =>
            command.type === "message.dispatch" && command.text === "new direction"
              ? {
                  ...command,
                  deliveryIntent: intent,
                  dispatchMode: { type: "start_immediately" as const },
                }
              : command,
          ),
          steps: materialized.steps,
          projectionThreadIds: materialized.projectionThreadIds,
          runtimePolicyOverride: { cwd },
        },
        harness,
      ).pipe(provideDeterministicTestRuntime);
      const projection = result.projections.get(materialized.projectionThreadIds[0]!)!;
      assert.deepEqual(
        projection.runs.map((run) => run.status),
        ["completed"],
      );
      assert.lengthOf(projection.attempts, native ? 1 : 2);
      assert.lengthOf(projection.providerTurns, native ? 1 : 2);
      assert.lengthOf(projection.providerSessions, 1);
      assert.lengthOf(projection.providerThreads, 1);
      assert.deepEqual(
        projection.messages
          .filter((message) => message.role === "user")
          .map((message) => message.text),
        ["original", "new direction"],
      );
      if (!native) assert.equal(projection.attempts[1]?.reason, "steering_restart");
    }).pipe(Effect.scoped),
);
