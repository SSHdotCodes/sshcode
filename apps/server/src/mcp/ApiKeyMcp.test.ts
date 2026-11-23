import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestratorMcpRequestSecretInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/ai";
import * as ServerConfig from "../config.ts";
import * as ApiKeyStore from "../secrets/ApiKeyStore.ts";
import * as ApiKeyVault from "../secrets/ApiKeyVault.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "./ThreadMetadataMcpService.ts";
import * as MonitorMcpService from "./MonitorMcpService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { liveThreadsLayer } from "./McpToolAccess.testkit.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import * as Handlers from "./toolkits/orchestrator/handlers.ts";

const threadId = ThreadId.make("api-key-thread");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("api-key-env"),
  requestNamespace: "fake-api-key-session",
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
  client: undefined,
  thread: {
    threadId,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: "fake-api-key-session",
  },
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect(
  "API key tools share private request plumbing, list metadata, and bind shell access to the authenticated thread",
  () =>
    Effect.gen(function* () {
      const requested: OrchestratorMcpRequestSecretInput[] = [];
      const prepared: Array<{ name: string; threadId: ThreadId }> = [];
      const listed: Array<ThreadId | undefined> = [];
      const layerToolkit = McpHttpServer.toolkitRegistration(
        OrchestratorToolkit,
        Handlers.layer,
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            liveThreadsLayer,
            Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({}),
            Layer.mock(MonitorMcpService.MonitorMcpService)({}),
            Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
              requestSecret: (_scope, input) =>
                Effect.sync(() => {
                  requested.push(input);
                  return { status: "api_key_saved", note: "Saved privately; use prepare_api_key." };
                }),
            }),
            Layer.mock(ApiKeyStore.ApiKeyStore)({
              list: (thread) =>
                Effect.sync(() => {
                  listed.push(thread);
                  return [
                    {
                      id: "fake-key-id",
                      name: "FAKE_API_KEY",
                      label: "Fake service",
                      scope: "chat",
                      threadId,
                      createdAt: 0,
                      expiresAt: 123_000,
                    },
                  ];
                }),
              prepare: (name, threadId) =>
                Effect.sync(() => {
                  prepared.push({ name, threadId });
                  return `fake-ticket-${name}`;
                }),
              secretRunCommand: Effect.succeed("sshcode secret run"),
            }),
          ),
        ),
      );
      return yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const invoke = (name: string, args: Record<string, unknown>, caller = scope) =>
          server
            .callTool({ name, arguments: args })
            .pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
              Effect.provideService(McpSchema.McpServerClient, client),
            );
        const request = yield* invoke("request_api_key", {
          name: "FAKE_API_KEY",
          label: "Fake service",
          reason: "Call the platform",
          suggestedScope: "all",
        });
        expect(request.isError).toBe(false);
        expect(requested).toEqual([
          {
            label: "Fake service",
            reason: "Call the platform",
            apiKey: { name: "FAKE_API_KEY", suggestedScope: "all" },
          },
        ]);
        const list = yield* invoke("list_api_keys", {});
        expect(list.isError).toBe(false);
        expect(listed).toEqual([threadId]);
        expect(list.structuredContent).toEqual([
          { name: "FAKE_API_KEY", scope: "chat", expiresAt: 123_000 },
        ]);
        const prepare = yield* invoke("prepare_api_key", { name: "FAKE_API_KEY" });
        expect(prepare.isError).toBe(false);
        expect(prepared).toEqual([{ name: "FAKE_API_KEY", threadId }]);
        expect(prepare.structuredContent).toMatchObject({
          command: expect.stringMatching(
            /^sshcode secret run --endpoint 'http:\/\/127\.0\.0\.1:\d+\/mcp\/api-key' --ticket 'fake-ticket-FAKE_API_KEY' --env FAKE_API_KEY --/,
          ),
        });
        // One call prepares several keys, each with its own ticket for this thread.
        const batch = yield* invoke("prepare_api_key", {
          names: ["FAKE_API_KEY", "OTHER_API_KEY"],
        });
        expect(batch.isError).toBe(false);
        expect(prepared).toEqual([
          { name: "FAKE_API_KEY", threadId },
          { name: "FAKE_API_KEY", threadId },
          { name: "OTHER_API_KEY", threadId },
        ]);
        expect(batch.structuredContent).toMatchObject({
          commands: [
            {
              name: "FAKE_API_KEY",
              command: expect.stringContaining("--ticket 'fake-ticket-FAKE_API_KEY'"),
            },
            {
              name: "OTHER_API_KEY",
              command: expect.stringContaining("--ticket 'fake-ticket-OTHER_API_KEY'"),
            },
          ],
        });
        const neither = yield* invoke("prepare_api_key", {});
        expect(neither.isError).toBe(true);
        const both = yield* invoke("prepare_api_key", {
          name: "FAKE_API_KEY",
          names: ["OTHER_API_KEY"],
        });
        expect(both.isError).toBe(true);
        expect(prepared).toHaveLength(3);
        const outside = yield* invoke(
          "prepare_api_key",
          { name: "FAKE_API_KEY" },
          {
            ...scope,
            thread: undefined,
            client: { sessionId: "external", label: "external", access: "full-access" },
          },
        );
        expect(outside.isError).toBe(true);
        expect(prepared).toHaveLength(3);
        expect(JSON.stringify([request, list, prepare, batch, outside])).not.toContain(
          "obviously-fake-secret-value",
        );
      }).pipe(Effect.provide(layerToolkit));
    }).pipe(
      Effect.provide(Layer.mergeAll(McpServer.McpServer.layer, NodeHttpServer.layerTest)),
      Effect.scoped,
    ),
);

it.effect(
  "batched prepare_api_key tickets stay single-use, expire, and never carry key values",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "api-key-mcp-test-" });
      // provideMerge shares the one store instance between the handler and the
      // test body, so redemptions see the tickets the tool issued.
      const layerToolkit = McpHttpServer.toolkitRegistration(
        OrchestratorToolkit,
        Handlers.layer,
      ).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            liveThreadsLayer,
            Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({}),
            Layer.mock(MonitorMcpService.MonitorMcpService)({}),
            Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({}),
            ApiKeyStore.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  ApiKeyVault.layerMemory,
                  ServerConfig.layerTest(directory, directory),
                ),
              ),
            ),
          ),
        ),
      );
      return yield* Effect.gen(function* () {
        const store = yield* ApiKeyStore.ApiKeyStore;
        yield* store.save({
          name: "FIRST_API_KEY",
          label: "First",
          scope: "chat",
          threadId,
          expiresAt: null,
          value: Redacted.make("obviously-fake-first-value"),
        });
        yield* store.save({
          name: "SECOND_API_KEY",
          label: "Second",
          scope: "chat",
          threadId,
          expiresAt: null,
          value: Redacted.make("obviously-fake-second-value"),
        });
        const server = yield* McpServer.McpServer;
        const result = yield* server
          .callTool({
            name: "prepare_api_key",
            arguments: { names: ["FIRST_API_KEY", "SECOND_API_KEY"] },
          })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        expect(result.isError).toBe(false);
        const { commands } = result.structuredContent as {
          commands: ReadonlyArray<{ name: string; command: string }>;
        };
        expect(commands.map((entry) => entry.name)).toEqual(["FIRST_API_KEY", "SECOND_API_KEY"]);
        const tickets = commands.map((entry) => /--ticket '([^']+)'/.exec(entry.command)![1]!);
        expect(new Set(tickets).size).toBe(2);
        expect(JSON.stringify(result)).not.toContain("obviously-fake");
        // Each ticket authorizes only its own key, exactly once.
        const first = yield* store.redeem(tickets[0]!);
        expect(first.name).toBe("FIRST_API_KEY");
        expect(Redacted.value(first.value)).toBe("obviously-fake-first-value");
        expect((yield* store.redeem(tickets[0]!).pipe(Effect.flip)).reason).toBe("invalid_ticket");
        const second = yield* store.redeem(tickets[1]!);
        expect(second.name).toBe("SECOND_API_KEY");
        expect(Redacted.value(second.value)).toBe("obviously-fake-second-value");
        expect((yield* store.redeem(tickets[1]!).pipe(Effect.flip)).reason).toBe("invalid_ticket");
        // The batch keeps the same 60-second expiry as a single ticket.
        const single = yield* server
          .callTool({ name: "prepare_api_key", arguments: { name: "FIRST_API_KEY" } })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        expect(single.isError).toBe(false);
        const ticket = /--ticket '([^']+)'/.exec(
          (single.structuredContent as { command: string }).command,
        )![1]!;
        yield* TestClock.adjust(60_000);
        expect((yield* store.redeem(ticket).pipe(Effect.flip)).reason).toBe("invalid_ticket");
      }).pipe(Effect.provide(layerToolkit));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          McpServer.McpServer.layer,
          NodeHttpServer.layerTest,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
      Effect.scoped,
    ),
);
