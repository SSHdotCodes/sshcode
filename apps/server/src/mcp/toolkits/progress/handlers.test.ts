import { afterEach, expect, it } from "@effect/vitest";
import {
  DEFAULT_AGENT_BEHAVIOR,
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { registerAgentBehavior } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as LiveProgress from "../../../liveProgress/LiveProgress.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { agentToolListVisible } from "../../AgentToolCatalog.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as Handlers from "./handlers.ts";
import { ProgressToolkit } from "./tools.ts";

const threadId = ThreadId.make("progress-thread");
const providerInstanceId = ProviderInstanceId.make("codex");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("progress-environment"),
  requestNamespace: "progress-test",
  issuedAt: 0,
  thread: { threadId, providerSessionId: "progress-session", providerInstanceId },
  client: undefined,
  capabilities: new Set(["orchestration"]),
};
const policy = { enabled: true, tools: {}, providers: {} };
const controls = { subagentsEnabled: () => true };

afterEach(() => registerAgentBehavior(() => DEFAULT_AGENT_BEHAVIOR));

it("is listed only at High token use", () => {
  expect(agentToolListVisible(policy, "report_progress", scope, controls)).toBe(false);
  registerAgentBehavior(() => ({ ...DEFAULT_AGENT_BEHAVIOR, tokens: "high" }));
  expect(agentToolListVisible(policy, "report_progress", scope, controls)).toBe(true);
  // An outside client has no chat to show progress in.
  expect(
    agentToolListVisible(policy, "report_progress", { ...scope, thread: undefined }, controls),
  ).toBe(false);
});

it.effect.each([
  ["a live run", "run-1", true],
  ["no live run", null, false],
] as const)("records progress for the calling chat with %s", ([, activeRunId, accepted]) =>
  Effect.gen(function* () {
    const reports: Array<Parameters<LiveProgress.LiveProgress["Service"]["report"]>[0]> = [];
    const shell = {
      id: threadId,
      providerInstanceId,
      archivedAt: null,
      deletedAt: null,
      activeRunId,
      runtimeMode: "full-access",
      interactionMode: "default",
      modelSelection: { instanceId: providerInstanceId, model: "gpt-6.1-sol" },
      activityRunStartedAt: DateTime.makeUnsafe(120_000),
    } as unknown as OrchestrationV2ThreadShell;
    const dependencies = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(shell),
      }),
      Layer.mock(LiveProgress.LiveProgress)({
        report: (input) => Effect.sync(() => void reports.push(input)),
      }),
    );
    const toolkit = yield* ProgressToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const input = {
      stages: [{ title: "Build the card", status: "active" as const, minutes: 8 }],
      update: "Server done; drawing the card.",
    };
    const events = yield* toolkit
      .handle("report_progress", input)
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    if (accepted) {
      expect(events.at(-1)?.result).toEqual({ ok: true });
      expect(reports).toEqual([
        { threadId, model: "gpt-6.1-sol", workStartedAt: 120_000, report: input },
      ]);
    } else {
      expect(events.at(-1)?.result).toMatchObject({ code: "parent_not_active" });
      expect(reports).toEqual([]);
    }
  }).pipe(Effect.scoped),
);
