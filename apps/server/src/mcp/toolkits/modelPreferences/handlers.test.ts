import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Tool } from "effect/ai";
import * as ModelPreferences from "../../../provider/ModelPreferences.ts";
import { agentToolCatalog, agentToolListVisible } from "../../AgentToolCatalog.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as Handlers from "./handlers.ts";
import { ModelPreferencesToolkit } from "./tools.ts";

it("advertises only one read-only model tool with bounded object input", () => {
  expect(Object.keys(ModelPreferencesToolkit.tools)).toEqual(["model_preferences"]);
  expect(agentToolCatalog.find((tool) => tool.name === "model_preferences")).toMatchObject({
    group: "models",
    readonly: true,
  });
  expect(Tool.getJsonSchema(ModelPreferencesToolkit.tools.model_preferences)).toMatchObject({
    type: "object",
  });
});

it.effect.each(["agent", "outside", "no-capability"] as const)(
  "read access is limited to a normal agent thread: %s",
  (caller) =>
    Effect.gen(function* () {
      let reads = 0;
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId: EnvironmentId.make("rankings-environment"),
        requestNamespace: "rankings-test",
        issuedAt: 0,
        thread:
          caller === "outside"
            ? undefined
            : {
                threadId: ThreadId.make("rankings-thread"),
                providerSessionId: "rankings-session",
                providerInstanceId: ProviderInstanceId.make("codex"),
              },
        client:
          caller === "outside"
            ? { sessionId: "outside", label: "Outside", access: "read-only" }
            : undefined,
        capabilities: new Set(caller === "no-capability" ? [] : ["orchestration"]),
      };
      const dependencies = Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
        Layer.mock(ModelPreferences.ModelPreferences)({
          lookup: (query) =>
            Effect.sync(() => {
              reads++;
              expect(query).toEqual({ task: "review", limit: 3 });
              return {
                matchedCategory: null,
                recommendations: [],
                unavailableCount: 0,
                notes: ["No saved preferences."],
              };
            }),
        }),
      );
      const toolkit = yield* ModelPreferencesToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const events = yield* toolkit
        .handle("model_preferences", { task: "review", limit: 3 })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      const policy = { enabled: true, tools: {}, providers: {} };
      expect(
        agentToolListVisible(policy, "model_preferences", scope, { subagentsEnabled: () => true }),
      ).toBe(caller === "agent");
      if (caller === "agent") {
        expect(reads).toBe(1);
        expect(events.at(-1)?.result).toMatchObject({ recommendations: [] });
      } else {
        expect(reads).toBe(0);
        expect(events.at(-1)?.result).toMatchObject({
          _tag: "OrchestratorMcpFailure",
          code: caller === "outside" ? "thread_credential_required" : "capability_denied",
        });
      }
    }).pipe(Effect.scoped),
);
