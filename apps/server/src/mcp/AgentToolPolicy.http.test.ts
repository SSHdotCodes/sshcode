import * as DebugLog from "../debug/DebugLog.ts";
import { QaSandbox } from "../preview/QaSandbox.ts";
import * as ComputerUseService from "../computer/ComputerUseService.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as MonitorService from "../monitors/MonitorService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as ServerConfig from "../config.ts";
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthMcpClientAccess,
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ServerSettingsError,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

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
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as AgentToolPolicy from "./AgentToolPolicy.ts";

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

const externalToken = "client-payload.client-signature";
const externalScope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-mcp-policy"),
  requestNamespace: "client:policy",
  thread: undefined,
  client: { sessionId: "policy", label: "External", access: "auto" },
  capabilities: new Set(["orchestration", "worktree", "pull-requests"]),
  issuedAt: 1,
};

const decodeRpc = (text: string) =>
  JSON.parse(text.match(/\{[\s\S]*\}/)![0]) as {
    readonly result?: {
      readonly capabilities?: { readonly tools?: { readonly listChanged?: boolean } };
      readonly tools?: ReadonlyArray<{ readonly name: string }>;
      readonly isError?: boolean;
      readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
    };
  };

const toolNames = (payload: ReturnType<typeof decodeRpc>) =>
  payload.result?.tools?.map((tool) => tool.name) ?? [];

const resultText = (payload: ReturnType<typeof decodeRpc>) =>
  payload.result?.content?.map((entry) => entry.text ?? "").join("\n") ?? "";

it.effect("filters and refuses tools on the same MCP session as settings change", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const screenshotRan = yield* Ref.make(false);
      const computerRan = yield* Ref.make(false);
      const failedRead = yield* Ref.make(false);
      const guardedSettings = {
        ...settings,
        getSettings: Ref.get(failedRead).pipe(
          Effect.flatMap((failed) =>
            failed
              ? Effect.fail(
                  new ServerSettingsError({
                    settingsPath: "/test/settings.json",
                    operation: "read-secret",
                  }),
                )
              : settings.getSettings,
          ),
        ),
      };
      const layerRoutes = McpHttpServer.layer.pipe(
        Layer.provide(
          Layer.mock(ComputerUseService.ComputerUseService)({
            status: () =>
              Ref.set(computerRan, true).pipe(
                Effect.as({
                  supported: true,
                  enabled: true,
                  paused: false,
                  driver: {
                    platform: "darwin",
                    installed: true,
                    accessibility: "granted",
                    screenRecording: "granted",
                    reason: null,
                  },
                  owner: null,
                  queued: [],
                  blockedAppIds: [],
                }),
              ),
          }),
        ),
        Layer.provide(Layer.succeed(ServerSettings.ServerSettingsService, guardedSettings)),
        Layer.provide(
          Layer.mock(DeviceService.DeviceService)({
            sessionsForThread: () => Ref.set(screenshotRan, true).pipe(Effect.as([])),
          }),
        ),
        Layer.provide(
          Layer.succeed(McpHttpServer.McpClientAuthenticator, {
            authenticate: (request) =>
              Effect.succeed(
                request.headers.authorization === `Bearer ${externalToken}`
                  ? externalScope
                  : undefined,
              ),
          }),
        ),
        Layer.provide(Layer.mock(ApiKeyStore.ApiKeyStore)({})),
        Layer.provide(Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({})),
        Layer.provide(
          Layer.mock(MonitorService.MonitorService)({
            canDeliver: () => true,
            ownsCwd: () => false,
            hasOpenWork: () => false,
          }),
        ),
        Layer.provide(
          McpSessionRegistry.layer.pipe(
            Layer.provide(AgentToolPolicy.layerDiscovery),
            Layer.provide(Layer.succeed(ServerSettings.ServerSettingsService, guardedSettings)),
          ),
        ),
      );
      yield* HttpRouter.serve(layerRoutes, {
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

      const httpClient = yield* HttpClient.HttpClient;
      const issue = (
        thread: string,
        provider: string,
        capabilities: ReadonlySet<"device" | "orchestration">,
      ) =>
        Effect.gen(function* () {
          const credential = yield* McpSessionRegistry.issueActiveMcpCredential({
            threadId: ThreadId.make(thread),
            providerInstanceId: ProviderInstanceId.make(provider),
            capabilities,
          });
          expect(credential).toBeDefined();
          return credential!.config;
        });
      const post = (authorization: string, sessionId: string | undefined, body: string) =>
        httpClient.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            authorization,
            ...(sessionId === undefined
              ? {}
              : { "mcp-protocol-version": "2025-06-18", "mcp-session-id": sessionId }),
          },
          body: HttpBody.text(body, "application/json"),
        });
      const openSession = (authorization: string) =>
        Effect.gen(function* () {
          const init = yield* post(
            authorization,
            undefined,
            `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"policy","version":"1.0.0"}}}`,
          );
          expect(init.status).toBe(200);
          const sessionId = init.headers["mcp-session-id"];
          expect(sessionId).toBeDefined();
          return { sessionId: sessionId!, init: decodeRpc(yield* init.text) };
        });
      const list = (authorization: string, sessionId: string, id: number) =>
        Effect.gen(function* () {
          const response = yield* post(
            authorization,
            sessionId,
            `{"jsonrpc":"2.0","id":${id},"method":"tools/list","params":{}}`,
          );
          expect(response.status).toBe(200);
          return toolNames(decodeRpc(yield* response.text));
        });
      const call = (
        authorization: string,
        sessionId: string,
        id: number,
        name: string,
        args: unknown,
      ) =>
        Effect.gen(function* () {
          const response = yield* post(
            authorization,
            sessionId,
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              method: "tools/call",
              params: { name, arguments: args },
            }),
          );
          expect(response.status).toBe(200);
          return decodeRpc(yield* response.text);
        });

      const configA = yield* issue("thread-a", "claudeAgent", new Set(["device"]));
      const providerA = configA.authorizationHeader;
      const opened = yield* openSession(providerA);
      expect(opened.init.result?.capabilities?.tools?.listChanged).toBe(true);
      const initial = yield* list(providerA, opened.sessionId, 2);
      const discovery = configA.toolDiscoveryCatalog!;
      expect(
        (yield* discovery)
          .split("\n")
          .map((line) => line.split(" — ")[0])
          .toSorted(),
      ).toEqual(initial.toSorted());
      expect(initial).toContain("delegate_task");
      expect(initial).toContain("device_screenshot");
      expect(initial).toContain("computer_status");
      expect(initial).toContain("computer_screenshot");
      expect(initial.some((name) => name.startsWith("preview_"))).toBe(false);
      expect(initial).not.toContain("t3_worktree_handoff");

      yield* settings.updateSettings({
        agentToolPolicy: {
          enabled: true,
          tools: { device_screenshot: false, computer_status: false, computer_screenshot: false },
          providers: {},
        },
      });
      const hidden = yield* list(providerA, opened.sessionId, 3);
      expect(yield* discovery).not.toContain("device_screenshot —");
      expect(yield* discovery).toContain("device_list —");
      expect(hidden).not.toContain("device_screenshot");
      expect(hidden).toContain("device_list");
      yield* Ref.set(screenshotRan, false);
      const denied = yield* call(providerA, opened.sessionId, 4, "device_screenshot", {
        providerInstanceId: "codex",
      });
      expect(denied.result?.isError).toBe(true);
      expect(resultText(denied)).toBe(
        AgentToolPolicy.disabledAgentToolMessage("device_screenshot"),
      );
      expect(yield* Ref.get(screenshotRan)).toBe(false);
      for (const [name, id] of [
        ["computer_status", 41],
        ["computer_screenshot", 42],
      ] as const) {
        const computerDenied = yield* call(providerA, opened.sessionId, id, name, {
          leaseId: "cached-lease",
        });
        expect(resultText(computerDenied)).toBe(AgentToolPolicy.disabledAgentToolMessage(name));
      }
      expect(yield* Ref.get(computerRan)).toBe(false);

      // A read error must keep cached calls blocked without publishing an empty catalog.
      yield* Ref.set(failedRead, true);
      const unavailable = yield* post(
        providerA,
        opened.sessionId,
        '{"jsonrpc":"2.0","id":91,"method":"tools/list","params":{}}',
      );
      expect(unavailable.status).toBe(503);
      expect(yield* unavailable.text).toContain("temporarily unavailable");
      const unavailableCall = yield* call(providerA, opened.sessionId, 92, "device_screenshot", {});
      expect(unavailableCall.result?.isError).toBe(true);
      expect(resultText(unavailableCall)).toContain("temporarily unavailable");
      expect(yield* Ref.get(screenshotRan)).toBe(false);
      yield* Ref.set(failedRead, false);
      expect(yield* list(providerA, opened.sessionId, 93)).not.toContain("device_screenshot");

      const codex = ProviderInstanceId.make("codex");
      yield* settings.updateSettings({
        agentToolPolicy: {
          enabled: true,
          tools: { device_screenshot: false },
          providers: {
            [codex]: { enabled: false, tools: { device_screenshot: true } },
          },
        },
      });
      const providerB = (yield* issue("thread-b", "codex", new Set(["device"])))
        .authorizationHeader;
      const openedB = yield* openSession(providerB);
      expect(yield* list(providerB, openedB.sessionId, 2)).toContain("device_screenshot");
      expect(yield* list(providerA, opened.sessionId, 5)).not.toContain("device_screenshot");
      yield* Ref.set(screenshotRan, false);
      const allowed = yield* call(providerB, openedB.sessionId, 6, "device_screenshot", {
        providerInstanceId: "claudeAgent",
      });
      // Policy lets the call through, so the device handler supplies its recovery message.
      expect(resultText(allowed)).toBe("No device is open in this thread. Call device_open first.");
      expect(resultText(allowed)).not.toContain("SSHCode Tools settings");
      expect(yield* Ref.get(screenshotRan)).toBe(true);
      yield* Ref.set(screenshotRan, false);
      const stillDenied = yield* call(providerA, opened.sessionId, 7, "device_screenshot", {
        providerInstanceId: "codex",
      });
      expect(resultText(stillDenied)).toBe(
        AgentToolPolicy.disabledAgentToolMessage("device_screenshot"),
      );
      expect(yield* Ref.get(screenshotRan)).toBe(false);

      yield* settings.updateSettings({
        agentToolPolicy: { enabled: true, tools: {}, providers: {} },
      });
      expect(yield* list(providerA, opened.sessionId, 8)).toContain("device_screenshot");
      const computerAllowed = yield* call(providerA, opened.sessionId, 81, "computer_status", {});
      // Policy lets it through now; native control then checks the caller's own
      // modes (this fixture has no thread to load), so the handler itself never runs.
      expect(resultText(computerAllowed)).not.toBe(
        AgentToolPolicy.disabledAgentToolMessage("computer_status"),
      );
      const reconnected = yield* openSession(providerA);
      expect(yield* list(providerA, reconnected.sessionId, 2)).toContain("device_screenshot");
      expect(yield* list(providerA, opened.sessionId, 9)).toContain("delegate_task");

      const noDevice = (yield* issue("thread-plain", "claudeAgent", new Set(["orchestration"])))
        .authorizationHeader;
      const openedPlain = yield* openSession(noDevice);
      const plainTools = yield* list(noDevice, openedPlain.sessionId, 2);
      expect(plainTools.some((name) => name.startsWith("device_"))).toBe(false);
      expect(plainTools.some((name) => name.startsWith("preview_"))).toBe(false);
      const capabilityDenied = yield* call(noDevice, openedPlain.sessionId, 3, "device_list", {});
      expect(resultText(capabilityDenied)).toContain(
        "Agent device access is turned off for this environment.",
      );
      expect(resultText(capabilityDenied)).not.toContain("SSHCode Tools settings");

      yield* settings.updateSettings({
        agentToolPolicy: {
          enabled: true,
          tools: { delegate_task: false },
          providers: {},
        },
      });
      const external = yield* openSession(`Bearer ${externalToken}`);
      const externalTools = yield* list(`Bearer ${externalToken}`, external.sessionId, 2);
      expect(externalTools).not.toContain("delegate_task");
      expect(externalTools.some((name) => name.startsWith("device_"))).toBe(false);
      expect(externalTools.some((name) => name.startsWith("preview_"))).toBe(false);
      const externalDenied = yield* call(
        `Bearer ${externalToken}`,
        external.sessionId,
        3,
        "delegate_task",
        { providerInstanceId: "codex" },
      );
      expect(resultText(externalDenied)).toBe(
        AgentToolPolicy.disabledAgentToolMessage("delegate_task"),
      );
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeHttpServer.layerTest,
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-tool-policy-http-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        NodeServices.layer,
        ServerSettings.layerTest(),
      ),
    ),
  ),
);

it.effect(
  "exposes read-only project listing to outside clients at every access level without widening writes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const timestamp = IsoDateTime.make("2026-06-17T00:00:00.000Z");
        const activeProject = {
          id: ProjectId.make("project:alpha"),
          title: "Alpha",
          workspaceRoot: "/work/alpha",
          defaultModelSelection: null,
          scripts: [],
          createdAt: timestamp,
          updatedAt: timestamp,
          deletedAt: null,
        };
        const deletedProject = {
          id: ProjectId.make("project:gone"),
          title: "Gone",
          workspaceRoot: "/work/gone",
          defaultModelSelection: null,
          scripts: [],
          createdAt: timestamp,
          updatedAt: timestamp,
          deletedAt: timestamp,
        };
        const tokenFor = (access: AuthMcpClientAccess) => `outside.${access}`;
        const scopes = new Map<string, McpInvocationContext.McpInvocationScope>(
          AuthMcpClientAccess.literals.map((access) => [
            `Bearer ${tokenFor(access)}`,
            {
              environmentId: EnvironmentId.make("environment-mcp-outside-access"),
              requestNamespace: `client:${access}`,
              thread: undefined,
              client: { sessionId: `session-${access}`, label: `Outside (${access})`, access },
              capabilities: new Set(["orchestration", "worktree", "pull-requests"] as const),
              issuedAt: 1,
            },
          ]),
        );
        const layerRoutes = McpHttpServer.layer.pipe(
          Layer.provide(
            Layer.succeed(McpHttpServer.McpClientAuthenticator, {
              authenticate: (request) =>
                Effect.succeed(
                  request.headers.authorization === undefined
                    ? undefined
                    : scopes.get(request.headers.authorization),
                ),
            }),
          ),
          Layer.provide(Layer.mock(ApiKeyStore.ApiKeyStore)({})),
          Layer.provide(Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({})),
          Layer.provide(
            Layer.mock(MonitorService.MonitorService)({
              canDeliver: () => true,
              ownsCwd: () => false,
              hasOpenWork: () => false,
            }),
          ),
          Layer.provide(Layer.mock(DeviceService.DeviceService)({})),
          Layer.provide(McpSessionRegistry.layer),
        );
        yield* HttpRouter.serve(layerRoutes, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(
          Layer.provide(
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed("environment-outside-access" as never),
            }),
          ),
          Layer.provide(PreviewAutomationBroker.layer),
          Layer.provide(Layer.mock(QaSandbox)({ touch: () => Effect.void })),
          Layer.provide(PreviewBrowser.layer),
          Layer.provide(
            Layer.mergeAll(
              layerStubServices,
              Layer.mock(ProjectService.ProjectService)({
                snapshot: Effect.succeed({
                  snapshotSequence: 1,
                  updatedAt: timestamp,
                  projects: [activeProject, deletedProject],
                }),
              }),
            ),
          ),
          Layer.build,
        );

        const httpClient = yield* HttpClient.HttpClient;
        const post = (authorization: string, sessionId: string | undefined, body: string) =>
          httpClient.post("/mcp", {
            headers: {
              accept: "application/json, text/event-stream",
              authorization,
              ...(sessionId === undefined
                ? {}
                : { "mcp-protocol-version": "2025-06-18", "mcp-session-id": sessionId }),
            },
            body: HttpBody.text(body, "application/json"),
          });

        for (const access of AuthMcpClientAccess.literals) {
          const auth = `Bearer ${tokenFor(access)}`;
          const init = yield* post(
            auth,
            undefined,
            `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"outside","version":"1.0.0"}}}`,
          );
          expect(init.status).toBe(200);
          const sessionId = init.headers["mcp-session-id"]!;

          const listed = yield* post(
            auth,
            sessionId,
            `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
          );
          expect(listed.status).toBe(200);
          const names = toolNames(decodeRpc(yield* listed.text));
          expect(names, access).toContain("t3_project_list");
          expect(names, access).toContain("create_threads");
          for (const forbidden of [
            "t3_project_create",
            "t3_project_update",
            "t3_project_delete",
            "t3_project_clone",
            "t3_thread_launch",
          ]) {
            expect(names, `${access} must not expose ${forbidden}`).not.toContain(forbidden);
          }

          const listCall = yield* post(
            auth,
            sessionId,
            JSON.stringify({
              jsonrpc: "2.0",
              id: 3,
              method: "tools/call",
              params: { name: "t3_project_list", arguments: {} },
            }),
          );
          expect(listCall.status).toBe(200);
          const listResult = decodeRpc(yield* listCall.text);
          expect(listResult.result?.isError, access).not.toBe(true);
          const parsed = JSON.parse(resultText(listResult)) as {
            readonly projects: ReadonlyArray<{
              readonly id: string;
              readonly title: string;
              readonly workspaceRoot: string;
            }>;
            readonly nextCursor: number | null;
          };
          expect(parsed.projects).toEqual([
            { id: activeProject.id, title: "Alpha", workspaceRoot: "/work/alpha" },
          ]);
          expect(parsed.nextCursor).toBeNull();
        }

        // Read-only still cannot start a chat, even when omitting projectId.
        const readOnlyAuth = `Bearer ${tokenFor("read-only")}`;
        const roInit = yield* post(
          readOnlyAuth,
          undefined,
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ro","version":"1.0.0"}}}`,
        );
        const roCreate = yield* post(
          readOnlyAuth,
          roInit.headers["mcp-session-id"]!,
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "create_threads", arguments: { threads: [{ prompt: "hi" }] } },
          }),
        );
        expect(roCreate.status).toBe(200);
        const roPayload = decodeRpc(yield* roCreate.text);
        expect(roPayload.result?.isError).toBe(true);
        expect(resultText(roPayload)).toContain("read-only access");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeHttpServer.layerTest,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-outside-access-http-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
          NodeServices.layer,
          ServerSettings.layerTest(),
        ),
      ),
    ),
);
