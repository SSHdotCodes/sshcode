import { assert, it } from "@effect/vitest";
import { type ProviderReplayEntry } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

import {
  ACP_REGISTRY_DEFAULT_INSTANCE_ID,
  ACP_REGISTRY_PROVIDER,
} from "@t3tools/provider-acp-registry/testing";
import { AcpRegistryOrchestratorReplayHarness } from "./Adapters/AcpRegistryAdapterV2.testkit.ts";
import { provideDeterministicTestRuntime } from "./testkit/DeterministicRuntime.ts";
import { runOrchestratorV2ProviderReplayScenario } from "./testkit/ProviderReplayHarness.ts";
import type { OrchestratorV2ScenarioStep } from "./testkit/OrchestratorScenario.ts";
import { materializeFixtureInput } from "./testkit/fixtures/shared.ts";

const request = (method: string): ProviderReplayEntry => ({
  type: "expect_outbound",
  frame: { kind: "request", method, params: "<any>" },
});
const reply = (method: string, result: unknown, label?: string): ProviderReplayEntry => ({
  type: "emit_inbound",
  ...(label === undefined ? {} : { label }),
  frame: { kind: "response", method, result },
});
const chunk = (sessionUpdate: string, text: string): ProviderReplayEntry => ({
  type: "emit_inbound",
  frame: {
    kind: "notification",
    method: "session/update",
    params: {
      sessionId: "steering-session",
      update: { sessionUpdate, content: { type: "text", text } },
    },
  },
});

it.effect.each([
  "accepted",
  "method-not-found",
  "unadvertised",
  "prompt-required",
  "started-new-turn",
] as const)("delivers negotiated ACP steering with %s support", (support) =>
  Effect.gen(function* () {
    const native = support === "accepted";
    const advertised = support !== "unadvertised";
    const name = `acp-steering-${support}`;
    const cwd = yield* checkpointWorkspace(name);
    const transcript = yield* AcpRegistryOrchestratorReplayHarness.decodeTranscript({
      provider: ACP_REGISTRY_PROVIDER,
      protocol: "acp.ndjson-jsonrpc",
      version: "1",
      scenario: name,
      entries: [
        request("initialize"),
        reply("initialize", {
          protocolVersion: 1,
          ...(advertised ? { _meta: { steering: { supported: true } } } : {}),
          agentCapabilities: { loadSession: false },
          authMethods: [],
        }),
        request("session/new"),
        reply("session/new", { sessionId: "steering-session" }),
        request("session/prompt"),
        chunk("agent_message_chunk", "working"),
        ...(advertised
          ? [
              {
                type: "expect_outbound" as const,
                frame: {
                  kind: "request",
                  method: "_session/steering",
                  params: {
                    sessionId: "steering-session",
                    prompt: [{ type: "text", text: "new direction" }],
                    _meta: { steering: { idleBehavior: "promptRequired" } },
                  },
                },
              },
              support === "method-not-found"
                ? {
                    type: "emit_inbound" as const,
                    frame: {
                      kind: "response",
                      method: "_session/steering",
                      error: { code: -32601, message: "Method not found" },
                    },
                  }
                : reply("_session/steering", {
                    outcome: native
                      ? "injected"
                      : support === "prompt-required"
                        ? "promptRequired"
                        : "startedNewTurn",
                    ...(support === "prompt-required" ? { reason: "noRunningTurn" } : {}),
                  }),
              ...(support === "started-new-turn"
                ? [
                    {
                      type: "expect_outbound" as const,
                      frame: {
                        kind: "notification",
                        method: "session/cancel",
                        params: { sessionId: "steering-session" },
                      },
                    },
                  ]
                : []),
            ]
          : []),
        ...(native
          ? [
              chunk("user_message_chunk", "new direction"),
              chunk("agent_message_chunk", "steered answer"),
            ]
          : []),
        reply("session/prompt", { stopReason: "end_turn" }, native ? undefined : "finish-first"),
        ...(native
          ? []
          : [
              request("session/prompt"),
              chunk("agent_message_chunk", "queued answer"),
              reply("session/prompt", { stopReason: "end_turn" }),
            ]),
      ],
    });
    const materialized = yield* materializeFixtureInput({
      scenario: name,
      driver: ACP_REGISTRY_PROVIDER,
      modelSelection: { instanceId: ACP_REGISTRY_DEFAULT_INSTANCE_ID, model: "default" },
      fixtureInput: {
        steps: [
          { type: "message", text: "original" },
          { type: "steer", text: "new direction", targetRunIndex: 1 },
        ],
      },
    }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
    const threadId = materialized.projectionThreadIds[0]!;
    const nextRunId = yield* Effect.gen(function* () {
      const ids = yield* IdAllocator.IdAllocatorV2;
      return ids.derive.run({ threadId, ordinal: 2 });
    }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
    const steps = native
      ? materialized.steps
      : materialized.steps.flatMap<OrchestratorV2ScenarioStep>((step) =>
          step.type === "await_thread_idle"
            ? [
                {
                  type: "await_run_status" as const,
                  threadId,
                  runId: nextRunId,
                  status: "queued" as const,
                },
                { type: "release_replay_gate" as const, label: "finish-first" },
                step,
              ]
            : [step],
        );
    const result = yield* runOrchestratorV2ProviderReplayScenario(
      {
        name,
        transcript,
        commands: materialized.commands,
        steps,
        projectionThreadIds: materialized.projectionThreadIds,
        runtimePolicyOverride: { cwd },
      },
      AcpRegistryOrchestratorReplayHarness,
    ).pipe(provideDeterministicTestRuntime);
    const projection = result.projections.get(threadId)!;
    assert.deepEqual(
      projection.runs.map((run) => run.status),
      native ? ["completed"] : ["completed", "completed"],
    );
    assert.lengthOf(projection.providerTurns, native ? 1 : 2);
    assert.lengthOf(projection.attempts, native ? 1 : 2);
    assert.deepEqual(
      projection.messages
        .filter((message) => message.role === "user")
        .map((message) => message.text),
      ["original", "new direction"],
    );
    assert.deepEqual(
      projection.turnItems
        .filter((item) => item.type === "user_message")
        .map((item) => item.inputIntent),
      native ? ["turn_start", "steer"] : ["turn_start", "queued_turn"],
    );
    assert.equal(
      projection.providerSessions[0]?.capabilities.turns.supportsActiveSteering,
      advertised,
    );
  }).pipe(Effect.scoped),
);
