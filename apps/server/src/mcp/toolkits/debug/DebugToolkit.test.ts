import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as DebugLog from "../../../debug/DebugLog.ts";
import * as DirectEndpoints from "../../../environment/DirectEndpoints.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Testkit from "../../McpToolAccess.testkit.ts";
import * as DebugHandlers from "./handlers.ts";
import { DebugToolkit } from "./tools.ts";

const decodeSession = Schema.decodeUnknownSync(
  Schema.Struct({
    sessionId: Schema.String,
    ingestUrl: Schema.String,
    remoteUrl: Schema.optional(Schema.String),
  }),
);

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "debug-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "debug-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("debug-environment"),
  requestNamespace: "debug-test",
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
  client: undefined,
  thread: {
    threadId: ThreadId.make("debug-owner"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: "debug-test",
  },
};
const service = DebugLog.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ServerConfig.ServerConfig)({
        port: 45679,
      } as ServerConfig.ServerConfig["Service"]),
      Layer.mock(DirectEndpoints.DirectEndpoints)({ resolve: () => Effect.succeed([]) }),
      Layer.mock(ServerSecretStore.ServerSecretStore)({ get: () => Effect.succeed(Option.none()) }),
    ),
  ),
);

it.effect("registers debug_log for agents and binds every action to the caller thread", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (args: Record<string, unknown>, caller = scope) =>
      server
        .callTool({ name: "debug_log", arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    const started = yield* call({ action: "start" });
    expect(started.isError).not.toBe(true);
    const session = decodeSession(started.structuredContent);
    expect(new URL(session.ingestUrl).pathname).toContain(session.sessionId);
    for (const action of ["read", "stop"]) {
      const other = yield* call(
        { action, sessionId: session.sessionId },
        { ...scope, thread: { ...scope.thread!, threadId: ThreadId.make("other") } },
      );
      expect(other.isError).toBe(true);
    }
    expect(
      (yield* call({ action: "read", sessionId: session.sessionId })).structuredContent,
    ).toEqual({ events: [], nextCursor: 0, hasMore: false });
    expect(
      (yield* call({ action: "stop", sessionId: session.sessionId })).structuredContent,
    ).toEqual({ stopped: true });
    expect((yield* call({ action: "read", sessionId: session.sessionId })).isError).toBe(true);
    expect((yield* call({ action: "read" })).isError).toBe(true);
    expect((yield* call({ action: "start" }, { ...scope, capabilities: new Set() })).isError).toBe(
      true,
    );
    expect((yield* call({ action: "start" }, { ...scope, thread: undefined })).isError).toBe(true);
  }).pipe(
    Effect.provide(
      McpHttpServer.toolkitRegistration(DebugToolkit, DebugHandlers.layer).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(service),
        Layer.provide(Testkit.liveThreadsLayer),
      ),
    ),
  ),
);
