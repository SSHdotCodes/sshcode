import * as DebugLog from "../debug/DebugLog.ts";
import { QaSandbox } from "../preview/QaSandbox.ts";
import * as ComputerUseService from "../computer/ComputerUseService.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as MonitorService from "../monitors/MonitorService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as ServerConfig from "../config.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ServerSettings as ServerSettingsSnapshot,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema } from "effect/ai";
import { HttpBody, HttpClient, HttpRouter, HttpServer } from "effect/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PullRequestReviewGuideService from "../pullRequest/PullRequestReviewGuideService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ApiKeyStore from "../secrets/ApiKeyStore.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpLiveNotifications from "./McpLiveNotifications.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";

const ownerScope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("env-live"),
  requestNamespace: "owner",
  capabilities: new Set(["device"]),
  issuedAt: 1,
  thread: {
    threadId: ThreadId.make("thread-live"),
    providerSessionId: "owner",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
};

const scopeWith = (
  patch: Partial<
    Pick<McpInvocationContext.McpInvocationScope, "environmentId" | "requestNamespace">
  >,
): McpInvocationContext.McpInvocationScope => ({ ...ownerScope, ...patch });

const decodeChunk = (chunk: Uint8Array) => new TextDecoder().decode(chunk);

it.effect("delivers list_changed and a keepalive, then releases the idle listener", () =>
  Effect.gen(function* () {
    const live = yield* McpLiveNotifications.McpLiveNotifications;
    yield* live.bindInitializedSession({
      sessionId: "session-1",
      protocolVersion: "2025-06-18",
      scope: ownerScope,
    });

    expect(
      yield* Effect.flip(
        live.listen({ sessionId: undefined, protocolVersion: undefined, scope: ownerScope }),
      ),
    ).toBeInstanceOf(McpLiveNotifications.McpListenMissingSession);
    expect(
      yield* Effect.flip(
        live.listen({
          sessionId: "session-1",
          protocolVersion: "2025-06-18",
          scope: scopeWith({ requestNamespace: "other" }),
        }),
      ),
    ).toBeInstanceOf(McpLiveNotifications.McpListenUnknownSession);
    expect(
      yield* Effect.flip(
        live.listen({
          sessionId: "session-1",
          protocolVersion: "2025-06-18",
          scope: scopeWith({ environmentId: EnvironmentId.make("env-other") }),
        }),
      ),
    ).toBeInstanceOf(McpLiveNotifications.McpListenUnknownSession);
    expect(
      yield* Effect.flip(
        live.listen({
          sessionId: "session-1",
          protocolVersion: "2025-11-25",
          scope: ownerScope,
        }),
      ),
    ).toBeInstanceOf(McpLiveNotifications.McpListenProtocolMismatch);

    const open = yield* live.listen({
      sessionId: "session-1",
      protocolVersion: undefined,
      scope: ownerScope,
    });
    expect(open.protocolVersion).toBe("2025-06-18");
    expect(
      yield* Effect.flip(
        live.listen({
          sessionId: "session-1",
          protocolVersion: "2025-06-18",
          scope: ownerScope,
        }),
      ),
    ).toBeInstanceOf(McpLiveNotifications.McpListenAlreadyAttached);

    const sawList = yield* Deferred.make<string>();
    const sawKeepalive = yield* Deferred.make<string>();
    const reader = yield* open.events.pipe(
      Stream.runForEach((chunk) => {
        const text = decodeChunk(chunk);
        const target = text.includes("keepalive")
          ? sawKeepalive
          : text.includes("notifications/tools/list_changed")
            ? sawList
            : undefined;
        return target === undefined
          ? Effect.void
          : Deferred.succeed(target, text).pipe(Effect.ignore);
      }),
      Effect.forkChild,
    );

    yield* live.publishToolsListChanged;
    expect(yield* Deferred.await(sawList)).toContain("notifications/tools/list_changed");
    yield* TestClock.adjust(McpLiveNotifications.MCP_SSE_KEEPALIVE);
    expect(yield* Deferred.await(sawKeepalive)).toContain(": keepalive");

    yield* Fiber.interrupt(reader);
    expect(yield* live.awaitListenerReleased).toBe("session-1");
    const again = yield* live.listen({
      sessionId: "session-1",
      protocolVersion: "2025-06-18",
      scope: ownerScope,
    });
    expect(again.sessionId).toBe("session-1");

    yield* live.endSession("session-1");
    expect(
      yield* Effect.flip(
        live.listen({
          sessionId: "session-1",
          protocolVersion: "2025-06-18",
          scope: ownerScope,
        }),
      ),
    ).toBeInstanceOf(McpLiveNotifications.McpListenUnknownSession);
    yield* live.endSession("session-1");
  }).pipe(Effect.provide(McpLiveNotifications.layer)),
);

const idleTtl = "1 minute";

it.effect("drops a disconnected session after the idle bound and keeps a live one", () =>
  Effect.gen(function* () {
    expect(McpLiveNotifications.MCP_SESSION_IDLE_TTL).toBe("24 hours");
    expect(McpLiveNotifications.MCP_SESSION_LIMIT).toBe(1_024);
    const live = yield* McpLiveNotifications.McpLiveNotifications;
    const listen = (sessionId: string) =>
      live.listen({ sessionId, protocolVersion: "2025-06-18", scope: ownerScope });
    yield* live.bindInitializedSession({
      sessionId: "kept",
      protocolVersion: "2025-06-18",
      scope: ownerScope,
    });
    const open = yield* listen("kept");
    const frames = yield* Queue.unbounded<string>();
    const reader = yield* open.events.pipe(
      Stream.runForEach((chunk) => Queue.offer(frames, decodeChunk(chunk))),
      Effect.forkChild,
    );
    yield* live.publishToolsListChanged;
    expect(
      yield* Effect.gen(function* () {
        let text = "";
        while (!text.includes("notifications/tools/list_changed")) {
          text = yield* Queue.take(frames);
        }
        return text;
      }),
    ).toContain("notifications/tools/list_changed");

    yield* TestClock.adjust(idleTtl);
    yield* live.publishToolsListChanged;
    const stillOpen = yield* Effect.gen(function* () {
      let text = "";
      while (!text.includes("notifications/tools/list_changed")) {
        text = yield* Queue.take(frames);
      }
      return text;
    });
    expect(stillOpen).toContain("notifications/tools/list_changed");
    expect(yield* Effect.flip(listen("kept"))).toBeInstanceOf(
      McpLiveNotifications.McpListenAlreadyAttached,
    );

    yield* Fiber.interrupt(reader);
    expect(yield* live.awaitListenerReleased).toBe("kept");
    yield* TestClock.adjust(idleTtl);
    expect(yield* Effect.flip(listen("kept"))).toBeInstanceOf(
      McpLiveNotifications.McpListenUnknownSession,
    );
  }).pipe(Effect.provide(McpLiveNotifications.layerWith({ idleTtl }))),
);

it.effect("evicts the oldest idle session before a live listener", () =>
  Effect.gen(function* () {
    const live = yield* McpLiveNotifications.McpLiveNotifications;
    const bind = (sessionId: string) =>
      live.bindInitializedSession({
        sessionId,
        protocolVersion: "2025-06-18",
        scope: ownerScope,
      });
    const listen = (sessionId: string) =>
      live.listen({ sessionId, protocolVersion: "2025-06-18", scope: ownerScope });

    yield* bind("live");
    const open = yield* listen("live");
    const saw = yield* Deferred.make<string>();
    const reader = yield* open.events.pipe(
      Stream.runForEach((chunk) => {
        const text = decodeChunk(chunk);
        return text.includes("notifications/tools/list_changed")
          ? Deferred.succeed(saw, text).pipe(Effect.ignore)
          : Effect.void;
      }),
      Effect.forkChild,
    );
    yield* bind("idle-old");
    yield* bind("idle-new");
    expect(yield* Effect.flip(listen("idle-old"))).toBeInstanceOf(
      McpLiveNotifications.McpListenUnknownSession,
    );

    yield* live.publishToolsListChanged;
    expect(yield* Deferred.await(saw)).toContain("notifications/tools/list_changed");
    expect(yield* Effect.flip(listen("live"))).toBeInstanceOf(
      McpLiveNotifications.McpListenAlreadyAttached,
    );
    const replaced = yield* listen("idle-new");
    expect(replaced.sessionId).toBe("idle-new");

    yield* bind("overflow");
    expect(yield* live.awaitListenerReleased).toBe("live");
    expect(yield* Effect.flip(listen("live"))).toBeInstanceOf(
      McpLiveNotifications.McpListenUnknownSession,
    );
    yield* Fiber.interrupt(reader);
  }).pipe(Effect.provide(McpLiveNotifications.layerWith({ limit: 2 }))),
);

const ownerToken = "ownerTokenWithoutDots";
const otherNamespaceToken = "otherNamespaceToken";
const otherEnvironmentToken = "otherEnvironmentToken";
const otherNamespaceScope = scopeWith({ requestNamespace: "other-namespace" });
const otherEnvironmentScope = scopeWith({
  environmentId: EnvironmentId.make("env-other"),
});

const layerTransport = McpHttpServer.layerMcpTransport.pipe(
  Layer.provide(ServerSettings.layerTest({})),
  Layer.provide(
    Layer.mock(McpSessionRegistry.McpSessionRegistry)({
      resolve: (presented) =>
        Effect.succeed(
          presented === ownerToken
            ? (ownerScope as McpInvocationContext.McpThreadInvocationScope)
            : presented === otherNamespaceToken
              ? (otherNamespaceScope as McpInvocationContext.McpThreadInvocationScope)
              : presented === otherEnvironmentToken
                ? (otherEnvironmentScope as McpInvocationContext.McpThreadInvocationScope)
                : undefined,
        ),
    }),
  ),
);

const headerRecord = (headers: Record<string, string | undefined>) =>
  Object.fromEntries(
    Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

it.effect("rejects a bad idle GET and cleans it up on disconnect and DELETE", () =>
  Effect.gen(function* () {
    const context = yield* HttpRouter.serve(layerTransport, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(Layer.build);
    const live = Context.get(context, McpLiveNotifications.McpLiveNotifications);
    const httpClient = yield* HttpClient.HttpClient;
    const readers: Array<Fiber.Fiber<void, unknown>> = [];
    yield* Effect.addFinalizer(() =>
      Effect.forEach(readers, (fiber) => Fiber.interrupt(fiber), { discard: true }),
    );

    const getMcp = (token: string | undefined, headers: Record<string, string | undefined> = {}) =>
      httpClient.get("/mcp", {
        headers: headerRecord({
          accept: "text/event-stream",
          authorization: token === undefined ? undefined : `Bearer ${token}`,
          ...headers,
        }),
      });

    const missingAuth = yield* getMcp(undefined);
    expect(missingAuth.status).toBe(401);
    expect(yield* missingAuth.json).toMatchObject({ error: "invalid_mcp_credential" });
    expect(missingAuth.headers["www-authenticate"]).toContain("Bearer");

    const badAuth = yield* getMcp("not-a-credential");
    expect(badAuth.status).toBe(401);
    expect(yield* badAuth.json).toMatchObject({ error: "invalid_mcp_credential" });
    expect(badAuth.headers["www-authenticate"]).toContain("invalid_token");

    const initialize = yield* httpClient.post("/mcp", {
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${ownerToken}`,
      },
      body: HttpBody.text(
        `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"live","version":"1.0.0"}}}`,
        "application/json",
      ),
    });
    expect(initialize.status).toBe(200);
    const sessionId = initialize.headers["mcp-session-id"];
    expect(sessionId).toBeDefined();
    yield* initialize.text;

    const methodNotAllowed = yield* httpClient.put("/mcp", {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(methodNotAllowed.status).toBe(405);
    expect(methodNotAllowed.headers.allow).toBe("POST, DELETE");
    yield* methodNotAllowed.text;

    const missingSession = yield* getMcp(ownerToken);
    expect(missingSession.status).toBe(400);
    yield* missingSession.text;

    const unknownSession = yield* getMcp(ownerToken, { "mcp-session-id": "missing-session" });
    expect(unknownSession.status).toBe(404);
    yield* unknownSession.text;

    const foreignNamespace = yield* getMcp(otherNamespaceToken, { "mcp-session-id": sessionId });
    expect(foreignNamespace.status).toBe(404);
    yield* foreignNamespace.text;

    const foreignEnvironment = yield* getMcp(otherEnvironmentToken, {
      "mcp-session-id": sessionId,
    });
    expect(foreignEnvironment.status).toBe(404);
    yield* foreignEnvironment.text;

    const badAccept = yield* getMcp(ownerToken, {
      accept: "application/json",
      "mcp-session-id": sessionId,
    });
    expect(badAccept.status).toBe(406);
    yield* badAccept.text;

    const rejectedStream = yield* getMcp(ownerToken, {
      accept: "text/event-stream;q=0",
      "mcp-session-id": sessionId,
    });
    expect(rejectedStream.status).toBe(406);
    yield* rejectedStream.text;

    const foreignOrigin = yield* getMcp(ownerToken, {
      origin: "https://evil.example",
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-06-18",
    });
    expect(foreignOrigin.status).toBe(403);
    yield* foreignOrigin.text;

    const mismatch = yield* getMcp(ownerToken, {
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-11-25",
    });
    expect(mismatch.status).toBe(400);
    expect(yield* mismatch.json).toMatchObject({
      jsonrpc: "2.0",
      error: { code: McpSchema.HEADER_MISMATCH_ERROR_CODE },
    });

    const open = yield* getMcp(ownerToken, { "mcp-session-id": sessionId });
    expect(open.status).toBe(200);
    expect(open.headers["content-type"]).toContain("text/event-stream");
    expect(open.headers["cache-control"]).toContain("no-cache");
    expect(open.headers["mcp-session-id"]).toBe(sessionId);
    expect(open.headers["mcp-protocol-version"]).toBe("2025-06-18");

    const frame = yield* Deferred.make<string>();
    const ended = yield* Deferred.make<void>();
    readers.push(
      yield* open.stream.pipe(
        Stream.runForEach((chunk) => {
          const text = decodeChunk(chunk);
          return text.includes("notifications/tools/list_changed")
            ? Deferred.succeed(frame, text).pipe(Effect.ignore)
            : Effect.void;
        }),
        Effect.ensuring(Deferred.succeed(ended, undefined)),
        Effect.forkChild,
      ),
    );

    const busy = yield* getMcp(ownerToken, {
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-06-18",
    });
    expect(busy.status).toBe(409);
    yield* busy.text;

    const foreignDelete = (token: string) =>
      httpClient.del("/mcp", {
        headers: { authorization: `Bearer ${token}`, "mcp-session-id": sessionId! },
      });
    const deletedByNamespace = yield* foreignDelete(otherNamespaceToken);
    expect(deletedByNamespace.status).toBe(404);
    yield* deletedByNamespace.text;
    const deletedByEnvironment = yield* foreignDelete(otherEnvironmentToken);
    expect(deletedByEnvironment.status).toBe(404);
    yield* deletedByEnvironment.text;
    const foreignList = yield* httpClient.post("/mcp", {
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${otherNamespaceToken}`,
        "mcp-session-id": sessionId!,
        "mcp-protocol-version": "2025-06-18",
      },
      body: HttpBody.text(
        `{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}`,
        "application/json",
      ),
    });
    expect(foreignList.status).toBe(404);
    yield* foreignList.text;

    const ownerList = yield* httpClient.post("/mcp", {
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${ownerToken}`,
        "mcp-session-id": sessionId!,
        "mcp-protocol-version": "2025-06-18",
      },
      body: HttpBody.text(
        `{"jsonrpc":"2.0","id":4,"method":"tools/list","params":{}}`,
        "application/json",
      ),
    });
    expect(ownerList.status).toBe(200);
    expect(yield* ownerList.text).toContain('"tools"');

    yield* live.publishToolsListChanged;
    expect(yield* Deferred.await(frame)).toContain("notifications/tools/list_changed");
    yield* Fiber.interrupt(readers[0]!);
    expect(yield* live.awaitListenerReleased).toBe(sessionId);

    const reattached = yield* getMcp(ownerToken, {
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-06-18",
    });
    expect(reattached.status).toBe(200);
    const endedAgain = yield* Deferred.make<void>();
    readers.push(
      yield* reattached.stream.pipe(
        Stream.runDrain,
        Effect.ensuring(Deferred.succeed(endedAgain, undefined)),
        Effect.forkChild,
      ),
    );

    const deleted = yield* httpClient.del("/mcp", {
      headers: { authorization: `Bearer ${ownerToken}`, "mcp-session-id": sessionId! },
    });
    expect(deleted.status).toBe(204);
    yield* deleted.text;
    yield* Deferred.await(endedAgain);

    const afterDelete = yield* getMcp(ownerToken, { "mcp-session-id": sessionId });
    expect(afterDelete.status).toBe(404);
    yield* afterDelete.text;

    const ping = yield* httpClient.post("/mcp", {
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${ownerToken}`,
        "mcp-session-id": sessionId!,
        "mcp-protocol-version": "2025-06-18",
      },
      body: HttpBody.text(
        `{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}`,
        "application/json",
      ),
    });
    expect(ping.status).toBe(404);
    yield* ping.text;
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

const layerStubServices = Layer.mergeAll(
  Layer.mock(DebugLog.DebugLog)({}),
  Layer.mock(ComputerUseService.ComputerUseService)({}),
  Layer.mock(UsageLimitSources.UsageLimitSources)({}),
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  Layer.mock(GitVcsDriver.GitVcsDriver)({}),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
  Layer.mock(PreviewManager.PreviewManager)({}),
  Layer.mock(ServerSecretStore.ServerSecretStore)({}),
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ThreadSearch.ThreadSearch)({}),
  McpProviderSessions.layer,
);

/**
 * `ServerSettings.layerTest` leaves `streamChanges` empty, so the production
 * watcher would never observe `updateSettings`. This double buffers the
 * patches and marks itself ready when that watcher starts reading.
 */
const makePublishingSettings = Effect.gen(function* () {
  const current = yield* Ref.make(DEFAULT_SERVER_SETTINGS);
  const changes = yield* Queue.unbounded<ServerSettingsSnapshot>();
  const subscribed = Deferred.makeUnsafe<void>();
  const updateSettings = (patch: ServerSettingsPatch) =>
    Ref.get(current).pipe(
      Effect.map((settings) => applyServerSettingsPatch(settings, patch)),
      Effect.tap((next) => Ref.set(current, next)),
      Effect.tap((next) => Queue.offer(changes, next)),
    );
  const service = {
    start: Effect.void,
    ready: Effect.void,
    getSettings: Ref.get(current),
    getProviderPolicy: Ref.get(current),
    updateSettings,
    modifySettings: () => Effect.die("Unexpected settings mutation"),
    updateProviderInstance: () =>
      Effect.die(
        "The MCP live-notification settings double does not edit provider instances.",
      ).pipe(Effect.andThen(Ref.get(current))),
    withSettingsSnapshot: <A, E, R>(
      use: (settings: ServerSettingsSnapshot) => Effect.Effect<A, E, R>,
    ) => Effect.flatMap(Ref.get(current), use),
    streamChanges: Stream.suspend(() => {
      Deferred.doneUnsafe(subscribed, Effect.void);
      return Stream.fromQueue(changes);
    }),
    subscribeChanges: Effect.succeed(Stream.empty),
  } satisfies ServerSettings.ServerSettingsService["Service"];
  return { service, subscribed };
});

it.effect("pushes tool list changes to an idle client on the same credential", () =>
  Effect.gen(function* () {
    const publishing = yield* makePublishingSettings;
    const layerRoutes = McpHttpServer.layer.pipe(
      Layer.provide(Layer.succeed(ServerSettings.ServerSettingsService, publishing.service)),
      Layer.provide(Layer.mock(DeviceService.DeviceService)({})),
      Layer.provide(Layer.mock(ApiKeyStore.ApiKeyStore)({})),
      Layer.provide(Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({})),
      Layer.provide(
        Layer.mock(MonitorService.MonitorService)({
          canDeliver: () => true,
          ownsCwd: () => false,
          hasOpenWork: () => false,
        }),
      ),
      Layer.provide(McpSessionRegistry.layer),
    );
    const context = yield* HttpRouter.serve(layerRoutes, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed("environment-scratch" as never),
        }),
      ),
      Layer.provide(PreviewAutomationBroker.layer),
      Layer.provide(Layer.mock(QaSandbox)({ touch: () => Effect.void })),
      Layer.provide(PreviewBrowser.layer),
      Layer.provide(layerStubServices),
      Layer.build,
    );
    const live = Context.get(context, McpLiveNotifications.McpLiveNotifications);
    // Node's server.close waits for every socket. The SDK keeps the idle GET
    // and its POST connections open, so this agent is destroyed before the
    // test scope closes the server.
    const dispatcher = new Agent();
    const address = HttpServer.formatAddress((yield* HttpServer.HttpServer).address);
    const credential = yield* McpSessionRegistry.issueActiveMcpCredential({
      threadId: ThreadId.make("thread-live-notify"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      capabilities: new Set(["device"]),
    });
    expect(credential).toBeDefined();
    const authorization = credential!.config.authorizationHeader;
    const listedAuthorization: Array<string> = [];
    const listedSessions: Array<string> = [];
    const getReady = Deferred.makeUnsafe<void>();
    const fetchWithMarker: FetchLike = async (input, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" ? init.body : "";
      if (method === "POST" && body.includes("tools/list")) {
        listedAuthorization.push(headers.get("authorization") ?? "");
        listedSessions.push(headers.get("mcp-session-id") ?? "");
      }
      // DOM RequestInit marks every field optional, which exactOptionalPropertyTypes
      // will not pass through to undici. The SDK only sets method, headers, body, and signal.
      const response = await undiciFetch(input, {
        ...(init?.method !== undefined ? { method: init.method } : {}),
        ...(init?.headers !== undefined ? { headers: init.headers } : {}),
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
        ...(init?.signal != null ? { signal: init.signal } : {}),
        dispatcher,
      } as UndiciRequestInit);
      if (method === "GET") {
        Deferred.doneUnsafe(
          getReady,
          response.ok ? Effect.void : Effect.die(`GET /mcp failed with ${response.status}`),
        );
      }
      return response;
    };

    let changed = Deferred.makeUnsafe<ReadonlyArray<string>>();
    const awaitChanged = Effect.gen(function* () {
      const names = yield* Deferred.await(changed);
      changed = Deferred.makeUnsafe();
      return names;
    });
    const client = new Client(
      { name: "live-notifications", version: "1.0.0" },
      {
        listChanged: {
          tools: {
            autoRefresh: true,
            debounceMs: 0,
            onChanged: (error, tools) => {
              Deferred.doneUnsafe(
                changed,
                error ? Effect.die(error) : Effect.succeed(tools?.map((tool) => tool.name) ?? []),
              );
            },
          },
        },
      },
    );
    const transport = new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
      requestInit: { headers: { authorization } },
      fetch: fetchWithMarker,
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1_000,
        maxReconnectionDelay: 1_000,
        reconnectionDelayGrowFactor: 1,
      },
    });
    const transportErrors: Array<string> = [];
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- The SDK transport exposes a callback, not EventTarget.
    transport.onerror = (error) => {
      transportErrors.push(error instanceof Error ? error.message : String(error));
    };
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await client.close().catch(() => undefined);
        await dispatcher.destroy();
      }),
    );
    yield* Effect.promise(() => client.connect(transport as Transport));
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);
    const sessionId = transport.sessionId;
    expect(sessionId).toBeDefined();
    yield* Deferred.await(getReady);
    yield* Deferred.await(publishing.subscribed);

    const namesOf = (tools: ReadonlyArray<{ readonly name: string }>) =>
      tools.map((tool) => tool.name);
    const initial = namesOf((yield* Effect.promise(() => client.listTools())).tools);
    expect(initial).toContain("device_screenshot");
    expect(initial).toContain("device_list");

    yield* publishing.service.updateSettings({
      agentToolPolicy: {
        enabled: true,
        tools: { device_screenshot: false },
        providers: {},
      },
    });
    const hidden = yield* awaitChanged;
    expect(hidden).not.toContain("device_screenshot");
    expect(hidden).toContain("device_list");
    expect(namesOf((yield* Effect.promise(() => client.listTools())).tools)).not.toContain(
      "device_screenshot",
    );

    yield* publishing.service.updateSettings({
      agentToolPolicy: { enabled: true, tools: {}, providers: {} },
    });
    const shown = yield* awaitChanged;
    expect(shown).toContain("device_screenshot");
    expect(namesOf((yield* Effect.promise(() => client.listTools())).tools)).toContain(
      "device_screenshot",
    );
    expect(transport.sessionId).toBe(sessionId);
    expect(listedAuthorization.length).toBeGreaterThan(0);
    expect(listedAuthorization.every((header) => header === authorization)).toBe(true);
    expect(listedSessions.every((header) => header === sessionId)).toBe(true);
    expect(transportErrors).toEqual([]);
    yield* Effect.promise(async () => {
      await client.close();
      await dispatcher.destroy();
    });
    expect(yield* live.awaitListenerReleased).toBe(sessionId);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeHttpServer.layerTest,
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-live-notifications-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        NodeServices.layer,
      ),
    ),
  ),
);
