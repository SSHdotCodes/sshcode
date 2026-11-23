import { assert, it } from "@effect/vitest";
import { ANTIGRAVITY_DEFAULT_MODEL, type ProviderReplayEntry } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as Effect from "effect/Effect";

import { driver, harness, instanceId, reply, request } from "./testkit/AntigravityReplayHarness.ts";
import { provideDeterministicTestRuntime } from "./testkit/DeterministicRuntime.ts";
import { runOrchestratorV2ProviderReplayScenario } from "./testkit/ProviderReplayHarness.ts";
import { materializeFixtureInput } from "./testkit/fixtures/shared.ts";

const update = (sessionUpdate: Record<string, unknown>): ProviderReplayEntry => ({
  type: "emit_inbound",
  frame: {
    kind: "notification",
    method: "session/update",
    params: { sessionId: "antigravity-session", update: sessionUpdate },
  },
});
const command = (toolCallId: string, commandLine: string) =>
  update({
    sessionUpdate: "tool_call",
    toolCallId,
    title: commandLine,
    kind: "execute",
    status: "in_progress",
    rawInput: { CommandLine: commandLine, WaitMsBeforeAsync: 5000 },
  });

it.effect("shows a command the agent killed as stopped and a real failure as failed", () =>
  Effect.gen(function* () {
    const name = "antigravity-killed-commands";
    const cwd = yield* checkpointWorkspace(name);
    // agy 1.5.13 frames: the agent kills its dev server through `manage_task`, and agy reports
    // the server failed with no exit code and no output at that moment. A test command that
    // could not run fails at the same moment with its output and exit code.
    const transcript = yield* harness.decodeTranscript({
      provider: driver,
      protocol: "acp.ndjson-jsonrpc",
      version: "1",
      scenario: name,
      entries: [
        request("initialize"),
        reply("initialize", {
          protocolVersion: 1,
          agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" },
          agentCapabilities: { loadSession: false },
          authMethods: [],
        }),
        request("session/new"),
        reply("session/new", {
          sessionId: "antigravity-session",
          modes: { currentModeId: "yolo", availableModes: [{ id: "yolo", name: "Full access" }] },
        }),
        request("session/prompt"),
        command("call_17286758284302709061", "npm run dev"),
        command("call_5809092998082118730", "npx vitest run"),
        update({
          sessionUpdate: "tool_call",
          toolCallId: "call_106207087879829302",
          title: "Run manage_task",
          kind: "other",
          status: "in_progress",
          rawInput: { Action: "kill", TaskId: "aa85bc44-0bb1-4c7e-9a52-3f0d0b6c1e27" },
        }),
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "call_17286758284302709061",
          status: "failed",
        }),
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "call_5809092998082118730",
          status: "failed",
          rawOutput: { combinedOutput: "sh: vitest: command not found\n", exitCode: 127 },
        }),
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "call_106207087879829302",
          status: "completed",
          rawOutput: "Task aa85bc44-0bb1-4c7e-9a52-3f0d0b6c1e27 killed.",
        }),
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Stopped the dev server." },
        }),
        reply("session/prompt", { stopReason: "end_turn" }),
      ],
    });
    const materialized = yield* materializeFixtureInput({
      scenario: name,
      driver,
      modelSelection: { instanceId, model: ANTIGRAVITY_DEFAULT_MODEL },
      fixtureInput: { steps: [{ type: "message", text: "stop the dev server" }] },
    }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
    const result = yield* runOrchestratorV2ProviderReplayScenario(
      {
        name,
        transcript,
        commands: materialized.commands,
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
    const commands = projection.turnItems.flatMap((item) =>
      item.type === "command_execution" ? [[item.input, item.status] as const] : [],
    );
    assert.deepEqual(commands, [
      ["npm run dev", "interrupted"],
      ["npx vitest run", "failed"],
    ]);
  }).pipe(Effect.scoped),
);
