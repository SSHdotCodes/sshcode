import { taskReference } from "../orchestration-v2/taskReference.ts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  ThreadId,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type WorkflowDefinition,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Config from "../config.ts";
import * as Database from "../persistence/Sqlite.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Replay from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import {
  makeTestAdapter,
  type CapturedTurn,
} from "../orchestration-v2/testkit/ProviderSwitch.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Worker from "../orchestration-v2/EffectWorker.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Folders from "../project/ManagedProjectFolders.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Setup from "../project/ProjectSetupScriptRunner.ts";
import * as SetupTracker from "../project/WorktreeSetupTracker.ts";
import * as CloneTracker from "../project/ProjectCloneTracker.ts";
import * as Terminals from "../terminal/Manager.ts";
import * as Git from "../git/GitWorkflowService.ts";
import * as GitDriver from "../vcs/GitVcsDriver.ts";
import * as Providers from "../provider/testUtils/providerRegistryMock.ts";
import * as Generation from "../textGeneration/TextGeneration.ts";
import * as Settings from "../serverSettings.ts";
import * as Usage from "../usage/UsageLimitSources.ts";
import * as Tasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Secrets from "../secrets/SecretRequests.ts";
import * as Mcp from "../mcp/OrchestratorMcpService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Workflows from "./WorkflowsService.ts";
import { catalog, selection, workflowFixture } from "./fixtures.ts";

it.live.each([
  { stopFirst: false, withOptions: false },
  { stopFirst: true, withOptions: false },
  { stopFirst: false, withOptions: true },
])(
  "runs and retries a workflow through real delegation (stop first: $stopFirst, effort: $withOptions)",
  ({ stopFirst, withOptions }) =>
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("workflows-e2e");
      const captured = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
      const leadStarted = yield* Deferred.make<void>(),
        releaseLead = yield* Deferred.make<void>();
      const childStarted = yield* Deferred.make<void>(),
        releaseChild = yield* Deferred.make<void>();
      const leadSelection = {
        ...selection,
        ...(withOptions ? { options: [{ id: "reasoningEffort", value: "xhigh" }] } : {}),
      };
      const capabilities = {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning effort",
            type: "select" as const,
            options: ["low", "high", "xhigh"].map((id) => ({ id, label: id })),
          },
        ],
      };
      const childSelection = {
        instanceId: ProviderInstanceId.make("worker-provider"),
        model: "gpt-6.1-sol",
        ...(withOptions ? { options: [{ id: "reasoningEffort", value: "low" }] } : {}),
      };
      const registry = Registry.layerFromAdapters([
        makeTestAdapter({
          instanceId: selection.instanceId,
          driver: ProviderDriverKind.make("codex"),
          capabilities: CodexProviderCapabilitiesV2,
          modelSelection: leadSelection,
          responseByRunOrdinal: { 1: "Lead finished" },
          capturedTurns: captured,
          holdFirstTurn: leadStarted,
          releaseFirstTurn: releaseLead,
        }),
        makeTestAdapter({
          instanceId: childSelection.instanceId,
          driver: ProviderDriverKind.make("codex"),
          capabilities: CodexProviderCapabilitiesV2,
          modelSelection: childSelection,
          responseByRunOrdinal: { 1: "Worker finished" },
          capturedTurns: captured,
          ...(stopFirst
            ? {
                holdFirstTurn: childStarted,
                releaseFirstTurn: releaseChild,
                interruptedRunOrdinals: new Set([1]),
              }
            : {}),
        }),
      ]);
      const database = Database.layerMemory;
      // One settings service, as in the app: the orchestrator checks the worker's
      // account against the same settings that thread management reads.
      const settings = Settings.layerTest({
        workflowsBeta: true,
        responseStreamingMode: "turn",
        providerInstances: { [childSelection.instanceId]: { driver: "codex", enabled: true } },
      });
      const replay = Replay.layerWithRegistry(
        {
          name: "workflows-e2e",
          runtimePolicyOverride: {
            cwd,
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly" },
          },
        },
        registry,
        { databaseLayer: database, serverSettingsLayer: settings.pipe(Layer.orDie) },
      );
      const receipts = Receipts.layer.pipe(Layer.provide(database));
      const threads = Threads.layer.pipe(Layer.provide(Layer.mergeAll(replay, settings, receipts)));
      const projectId = ProjectId.make("workflow-project");
      const project = {
        id: projectId,
        title: "Workflows",
        workspaceRoot: cwd,
        repositoryIdentity: null,
        faviconPath: null,
        defaultModelSelection: selection,
        defaultThreadEnvMode: null,
        scripts: [],
        createdAt: "2026-11-06T00:00:00.000Z",
        updatedAt: "2026-11-06T00:00:00.000Z",
        deletedAt: null,
      };
      const external = Layer.mergeAll(
        Config.layerTest(cwd, { prefix: "workflow-integration-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        NodeServices.layer,
        NodeCrypto.layer,
        settings,
        Providers.layer([
          ...catalog.map((provider) => ({
            ...provider,
            models: provider.models.map((model) => ({ ...model, capabilities })),
          })),
          {
            ...catalog[0]!,
            instanceId: childSelection.instanceId,
            models: [
              {
                ...catalog[0]!.models[0]!,
                slug: childSelection.model,
                name: "GPT-6.1 Sol",
                capabilities,
              },
            ],
          },
        ]),
        Layer.mock(Projects.ProjectService)({
          getById: () => Effect.succeed(Option.some(project)),
        }),
        Layer.mock(Folders.ManagedProjectFolders)({
          namedProjectsRoot: "",
          ensureScratchProject: Effect.succeed({ projectId }),
          folderForThread: () => Effect.succeed(Option.none()),
        }),
        Layer.mock(Generation.TextGeneration)({}),
        Layer.mock(Git.GitWorkflowService)({}),
        Layer.mock(GitDriver.GitVcsDriver)({}),
        Layer.mock(Setup.ProjectSetupScriptRunner)({
          runForThread: () => Effect.succeed({ status: "no-script" as const }),
        }),
        SetupTracker.layer,
        Layer.mock(CloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
        Layer.mock(Terminals.TerminalManager)({ close: () => Effect.void }),
        Layer.mock(Usage.UsageLimitSources)({ current: Effect.succeed([]) }),
        Layer.mock(Tasks.ScheduledTaskService)({}),
        Layer.mock(Secrets.SecretRequests)({}),
      );
      const launch = Launch.layer.pipe(
        Layer.provide(Layer.mergeAll(external, threads, receipts, IdAllocator.layer)),
      );
      const workflows = Workflows.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(external, threads, launch, registry)),
      );
      const all = Mcp.layer.pipe(Layer.provideMerge(workflows), Layer.provideMerge(replay));
      yield* Effect.gen(function* () {
        const service = yield* Workflows.WorkflowsService,
          orchestrator = yield* Orchestrator.OrchestratorV2,
          mcp = yield* Mcp.OrchestratorMcpService,
          worker = yield* Worker.OrchestrationEffectWorkerV2;
        const source = workflowFixture();
        const workflow: WorkflowDefinition = {
          ...source,
          nodes: source.nodes
            .slice(0, 2)
            .map((n) =>
              n.kind === "agent"
                ? { ...n, model: n.id === "worker" ? childSelection : leadSelection }
                : n,
            ),
          edges: source.edges.slice(0, 1),
        };
        yield* service.mutate({ type: "save", workflow });
        const started = yield* service.start({
          workflowId: workflow.id,
          task: "Finish the drawn workflow",
        });
        yield* Deferred.await(leadStarted);
        const lead = yield* orchestrator.getThreadProjection(started.leadThreadId);
        expect(lead.thread.creationSource).toBe("workflows");
        expect(lead.thread.modelSelection).toEqual(leadSelection);
        const scope: McpInvocationScope = {
          environmentId: EnvironmentId.make("workflow-test"),
          requestNamespace: "workflow-session",
          thread: {
            threadId: lead.thread.id,
            providerInstanceId: selection.instanceId,
            providerSessionId: lead.providerSessions[0]!.id,
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };
        const wrong = yield* mcp
          .delegateTask(scope, {
            task: "Work",
            title: "worker",
            target: { model: selection.model },
            clientRequestId: "wrong",
          })
          .pipe(Effect.result);
        expect(wrong._tag).toBe("Failure");
        const delegated = yield* mcp.delegateTask(scope, {
          task: "Work",
          title: "worker",
          target: { providerInstanceId: childSelection.instanceId, model: childSelection.model },
          mode: stopFirst ? "async" : "wait",
          clientRequestId: "worker",
        });
        if (stopFirst) {
          yield* Deferred.await(childStarted);
          yield* service.mutate({
            type: "stopAgent",
            runId: started.runId,
            threadId: delegated.childThreadId,
          });
          yield* Deferred.succeed(releaseChild, undefined);
          yield* orchestrator
            .streamStoredEventsFrom({ threadId: lead.thread.id, eventType: "subagent.updated" })
            .pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "subagent.updated" &&
                  taskReference(event.payload.id) === delegated.taskId &&
                  event.payload.status === "cancelled",
              ),
              Stream.runHead,
            );
          expect(
            (yield* orchestrator.getThreadProjection(lead.thread.id)).subagents.find(
              (t) => taskReference(t.id) === delegated.taskId,
            )?.status,
          ).toBe("cancelled");
        } else expect(delegated.status).toBe("completed");
        const child = yield* orchestrator.getThreadProjection(delegated.childThreadId);
        expect(child.thread.modelSelection).toEqual(childSelection);
        expect(child.messages[0]!.text).toContain("No child boxes. Do not delegate.");
        expect(child.messages[0]!.text).not.toContain("lead brief");
        expect(child.messages[0]!.context?.records[0]).toMatchObject({
          kind: "workflow",
          nodeId: "worker",
        });
        yield* service.refresh;
        yield* service.mutate({
          type: "retryAgent",
          runId: started.runId,
          threadId: delegated.childThreadId,
        });
        const retryState = yield* service
          .subscribe()
          .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
        const retry = retryState.runs[0]!.agents.find(
          (a) => a.retryOf === delegated.childThreadId,
        )!;
        expect(retry).toMatchObject({ nodeId: "worker", slot: 0, parentThreadId: lead.thread.id });
        const retried = yield* orchestrator.getThreadProjection(retry.threadId);
        expect(retried.thread.modelSelection).toEqual(childSelection);
        expect(retried.thread.lineage.parentThreadId).toBe(lead.thread.id);
        expect(retried.messages[0]!.text).toBe(child.messages[0]!.text);
        yield* orchestrator
          .streamStoredEventsFrom({ threadId: lead.thread.id, eventType: "subagent.updated" })
          .pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "subagent.updated" &&
                event.payload.childThreadId === retry.threadId &&
                event.payload.result !== null,
            ),
            Stream.runHead,
          );
        yield* Deferred.succeed(releaseLead, undefined);
        yield* orchestrator
          .streamStoredEventsFrom({ threadId: lead.thread.id, eventType: "run.updated" })
          .pipe(
            Stream.filter(
              ({ event }) => event.type === "run.updated" && event.payload.status === "completed",
            ),
            Stream.runHead,
          );
        yield* worker.drain();
        yield* orchestrator
          .streamStoredEventsFrom({ threadId: lead.thread.id, eventType: "run.updated" })
          .pipe(
            Stream.mapEffect(() => orchestrator.getThreadRecords(lead.thread.id, ["runs"])),
            Stream.filter((p) =>
              p.runs.every((r) =>
                ["completed", "failed", "cancelled", "interrupted"].includes(r.status),
              ),
            ),
            Stream.runHead,
          );
        yield* worker.drain();
        yield* service.refresh;
        const state = yield* service
          .subscribe()
          .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
        expect(state.runs[0]).toMatchObject({
          id: started.runId,
          status: "completed",
          agents: [
            expect.objectContaining({ nodeId: "lead", status: "completed" }),
            expect.objectContaining({
              nodeId: "worker",
              status: stopFirst ? "cancelled" : "completed",
            }),
            expect.objectContaining({
              nodeId: "worker",
              retryOf: delegated.childThreadId,
              status: stopFirst ? "interrupted" : "completed",
            }),
          ],
        });
        expect(
          (yield* Ref.get(captured)).filter(
            (turn) => turn.modelSelection.model === childSelection.model,
          ),
        ).toHaveLength(2);
        for (const turn of yield* Ref.get(captured)) {
          expect(turn.modelSelection).toEqual(
            turn.modelSelection.model === childSelection.model ? childSelection : leadSelection,
          );
        }
        const parentAfter = yield* orchestrator.getThreadProjection(lead.thread.id);
        expect(
          parentAfter.messages.filter((m) => m.text.startsWith("Retry started:")),
        ).toHaveLength(1);
        expect(
          parentAfter.contextTransfers.filter(
            (t) => t.type === "subagent_result" && t.sourceThreadId === retry.threadId,
          ),
        ).toHaveLength(1);
        expect(
          parentAfter.subagents.find((t) => t.childThreadId === retry.threadId)?.completionWake,
        ).toBe("always");
        if (stopFirst) return;
        const chat = ThreadId.make("normal-chat");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("normal-chat"),
          threadId: chat,
          projectId,
          title: "Normal chat",
          modelSelection: childSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        const fromChat = yield* service.start({
          workflowId: workflow.id,
          task: "Use my chat model",
          chatThreadId: chat,
        });
        yield* orchestrator
          .streamStoredEventsFrom({ threadId: chat, eventType: "run.updated" })
          .pipe(
            Stream.filter(
              ({ event }) => event.type === "run.updated" && event.payload.status === "completed",
            ),
            Stream.runHead,
          );
        yield* worker.drain();
        yield* service.refresh;
        const reused = yield* orchestrator.getThreadProjection(chat);
        expect(reused.thread.creationSource).toBe("web");
        expect(reused.thread.modelSelection).toEqual(childSelection);
        expect(reused.messages[0]!.context?.records[0]).toMatchObject({
          kind: "workflow",
          runId: fromChat.runId,
        });
        const after = yield* service
          .subscribe()
          .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
        expect(after.runs[0]).toMatchObject({
          origin: "chat",
          leadThreadId: chat,
          status: "completed",
        });
      }).pipe(Effect.provide(all));
    }).pipe(Effect.scoped),
  60_000,
);
