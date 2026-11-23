import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MonitorError,
  ProviderInstanceId,
  ThreadId,
  type MonitorInfo,
  type MonitorStartInput,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as ApiKeyStore from "../secrets/ApiKeyStore.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { McpSchema, McpServer } from "effect/ai";

import * as MonitorService from "../monitors/MonitorService.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as MonitorMcpService from "./MonitorMcpService.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "./ThreadMetadataMcpService.ts";
import * as Handlers from "./toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";

const threadId = ThreadId.make("thread:monitor-mcp");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:test"),
  requestNamespace: "provider:test",
  capabilities: new Set(["orchestration"]),
  thread: {
    threadId,
    providerSessionId: "session:test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
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

const withToolkit = <A, E, R>(
  test: (input: {
    readonly invoke: (
      name: string,
      args: Record<string, unknown>,
      caller?: McpInvocationContext.McpInvocationScope,
    ) => Effect.Effect<McpSchema.CallToolResult, McpSchema.InternalError | McpSchema.InvalidParams>;
    readonly caller: Ref.Ref<OrchestrationV2ThreadShell>;
    readonly starts: Ref.Ref<
      ReadonlyArray<
        MonitorStartInput & {
          readonly cwd: string;
          readonly threadId: ThreadId;
          readonly requestNamespace: string;
        }
      >
    >;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const caller = yield* Ref.make<OrchestrationV2ThreadShell>({
      ...liveThreadShell(threadId),
      worktreePath: "/scratch/projectless-chat",
    });
    const starts = yield* Ref.make<
      ReadonlyArray<
        MonitorStartInput & {
          readonly cwd: string;
          readonly threadId: ThreadId;
          readonly requestNamespace: string;
        }
      >
    >([]);
    const roster = yield* Ref.make<ReadonlyArray<MonitorInfo>>([]);
    return yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      return yield* test({
        invoke: (name, args, invocation = scope) =>
          server
            .callTool({ name, arguments: args })
            .pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
              Effect.provideService(McpSchema.McpServerClient, client),
            ),
        caller,
        starts,
      });
    }).pipe(
      Effect.provide(
        McpHttpServer.toolkitRegistration(OrchestratorToolkit, Handlers.layer).pipe(
          Layer.provide(Layer.mock(ApiKeyStore.ApiKeyStore)({})),
          Layer.provide(MonitorMcpService.layer),
          Layer.provide(ThreadCommandExecutor.layer),
          Layer.provide(Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({})),
          Layer.provide(Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({})),
          Layer.provide(
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: () => Ref.get(caller),
            }),
          ),
          Layer.provide(
            Layer.mock(ProjectService.ProjectService)({
              getById: () => Effect.succeed(Option.none()),
            }),
          ),
          Layer.provide(
            Layer.mock(MonitorService.MonitorService)({
              canDeliver: () => true,
              ownsCwd: () => false,
              hasOpenWork: () => false,
              start: (input) =>
                Ref.update(starts, (current) => [...current, input]).pipe(
                  Effect.andThen(
                    Ref.set(roster, [
                      {
                        monitorId: "monitor:test",
                        threadId: input.threadId,
                        description: input.description,
                        startedAt: 0,
                        timeoutMs: 3_600_000,
                        persistent: false,
                      },
                    ]),
                  ),
                  Effect.as({ monitorId: "monitor:test" }),
                ),
              list: () => Ref.get(roster),
              stop: (_threadId, monitorId) =>
                monitorId === "monitor:foreign"
                  ? Effect.fail(new MonitorError({ reason: "not-found" }))
                  : Ref.set(roster, []).pipe(Effect.as(true)),
            }),
          ),
          Layer.provideMerge(McpServer.McpServer.layer),
        ),
      ),
    );
  }).pipe(Effect.scoped);

describe("monitor MCP tools", () => {
  it.effect("starts in the calling thread's scratch/worktree directory, lists and stops", () =>
    withToolkit(({ invoke, starts }) =>
      Effect.gen(function* () {
        const result = yield* invoke("monitor_start", {
          command: "until curl -sf localhost:8080; do sleep 5; done; echo ready",
          description: "Wait for server",
          clientRequestId: "retry",
        });
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toEqual({
          monitorId: "monitor:test",
          wakePolicy: "Throttled output + exit; use wakeOn:regex or false.",
        });
        expect((yield* Ref.get(starts))[0]).toMatchObject({
          cwd: "/scratch/projectless-chat",
          threadId,
          requestNamespace: "provider:test",
          clientRequestId: "retry",
        });
        const listed = (yield* invoke("monitor_list", {})).structuredContent;
        expect(listed).toMatchObject({ monitors: [{ description: "Wait for server" }] });
        expect(listed).not.toHaveProperty("notice");
        // Asking again with nothing changed says the monitor wakes the thread itself.
        expect((yield* invoke("monitor_list", {})).structuredContent).toMatchObject({
          monitors: [{ description: "Wait for server" }],
          notice: expect.stringContaining(
            "Monitor exit (or output selected by its policy) wakes this thread",
          ),
        });
        expect(
          (yield* invoke("monitor_stop", { monitorId: "monitor:test" })).structuredContent,
        ).toEqual({ stopped: true });
        expect((yield* invoke("monitor_list", {})).structuredContent).toEqual({ monitors: [] });
        expect((yield* invoke("monitor_stop", { monitorId: "monitor:foreign" })).isError).toBe(
          true,
        );
      }),
    ),
  );

  it.effect.each([
    [{ wakeOn: false }, "Exit only; set wakeOn to a regex for milestones."],
    [{ wakeOn: "^ready" }, "Matches + exit; omit wakeOn for throttled output."],
    [{ durable: true }, "Exit only; set wakeOn to a regex for milestones."],
    [{ durable: true, wakeOn: "^ready" }, "Matches + exit; use wakeOn:false for exit only."],
  ] as const)("reports the wake policy for %j", ([options, wakePolicy]) =>
    withToolkit(({ invoke }) =>
      Effect.gen(function* () {
        const result = yield* invoke("monitor_start", {
          command: "watch",
          description: "Watch",
          ...options,
        });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ wakePolicy });
      }),
    ),
  );

  it.effect(
    "refuses outside clients, stale providers, archived threads and supervised callers",
    () =>
      withToolkit(({ invoke, caller, starts }) =>
        Effect.gen(function* () {
          const input = { command: "echo ready", description: "Ready" };
          const base = yield* Ref.get(caller);
          expect(
            (yield* invoke("monitor_start", input, { ...scope, thread: undefined })).isError,
          ).toBe(true);
          for (const changed of [
            { activeRunId: null },
            { providerInstanceId: ProviderInstanceId.make("other") },
            { archivedAt: base.createdAt },
            { runtimeMode: "approval-required" as const },
            { interactionMode: "plan" as const },
          ]) {
            yield* Ref.set(caller, { ...base, ...changed });
            expect((yield* invoke("monitor_start", input)).isError).toBe(true);
          }
          expect(yield* Ref.get(starts)).toEqual([]);
        }),
      ),
  );

  it.effect("rejects invalid timeouts at the MCP schema boundary", () =>
    withToolkit(({ invoke, starts }) =>
      Effect.gen(function* () {
        for (const timeoutMs of [0, -1, 86_400_001, 1.5]) {
          const result = yield* invoke("monitor_start", {
            command: "echo ready",
            description: "Ready",
            timeoutMs,
          }).pipe(Effect.result);
          expect(result._tag === "Failure" || result.success.isError === true).toBe(true);
        }
        expect(yield* Ref.get(starts)).toEqual([]);
      }),
    ),
  );

  it.effect("starts a stream piped into a buffering filter and warns with the fix", () =>
    withToolkit(({ invoke, starts }) =>
      Effect.gen(function* () {
        const command =
          "ssh host 'journalctl -f -u job' | grep --line-buffered Error | cut -c1-900";
        const result = yield* invoke("monitor_start", { command, description: "Job errors" });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ monitorId: expect.any(String) });
        expect(JSON.stringify(result.structuredContent)).toContain("fflush()");
        expect((yield* Ref.get(starts)).map((start) => start.command)).toEqual([command]);
        const clean = yield* invoke("monitor_start", {
          command: "tail -f app.log | grep --line-buffered Error",
          description: "Clean",
        });
        expect(clean.structuredContent).not.toHaveProperty("warning");
      }),
    ),
  );
});
