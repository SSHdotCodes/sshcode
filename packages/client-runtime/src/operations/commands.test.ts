import { expandDebugCommand } from "@t3tools/shared/debugCommand";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  EnvironmentId,
  MessageId,
  NodeId,
  ORCHESTRATION_V2_WS_METHODS,
  ComposerContextId,
  PlanId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  WS_METHODS,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadProjection,
  type ProjectMutation,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { RpcClientError } from "effect/rpc";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { v2Now, v2Projection, v2ThreadId } from "../state/orchestrationV2TestFixtures.ts";
import { comparisonThreadInput } from "../state/modelComparison.ts";
import {
  archiveThread,
  cancelQueuedRun,
  createProject,
  dismissThreadUserInput,
  editQueuedRun,
  forkThreadFromRun,
  interruptThreadTurn,
  mergeThreadBack,
  prepareThreadTurn,
  promoteQueuedRun,
  reorderActiveThread,
  reorderQueuedRun,
  respondToThreadApproval,
  respondToThreadUserInput,
  revertThreadCheckpoint,
  settleThread,
  startThreadTurn,
  unsettleThread,
  updateProject,
  updateThreadMetadata,
} from "./commands.ts";

const layerTestCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const CONNECTED_STATE: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  phase: "connected",
};

const socketClosed = () =>
  new RpcClientError.RpcClientError({
    reason: new RpcClientError.RpcClientDefect({
      message: "socket closed",
      cause: new Error("socket closed"),
    }),
  });

const helloTurn = (id: string, resendAfterSocketLoss?: boolean) => ({
  commandId: CommandId.make(`command-${id}`),
  threadId: v2ThreadId,
  message: {
    messageId: MessageId.make(`message-${id}`),
    role: "user" as const,
    text: "hello",
    attachments: [],
  },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  ...(resendAfterSocketLoss === undefined ? {} : { resendAfterSocketLoss }),
});

const makeSupervisor = Effect.fn("TestEnvironmentCommands.makeSupervisor")(function* (input: {
  readonly commands: OrchestrationV2Command[];
  readonly projects: ProjectMutation[];
  readonly launches?: OrchestrationV2ThreadLaunchInput[];
  readonly projection?: OrchestrationV2ThreadProjection;
  readonly projectionRequests?: ThreadId[];
  readonly advertiseServerResolvedCommandContext?: boolean;
}) {
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
      Effect.sync(() => {
        input.commands.push(command);
        return { sequence: input.commands.length };
      }),
    [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: (requestInput: {
      readonly threadId: ThreadId;
    }) =>
      Effect.sync(() => {
        input.projectionRequests?.push(requestInput.threadId);
        return input.projection ?? v2Projection;
      }),
    [ORCHESTRATION_V2_WS_METHODS.launchThread]: (launchInput: OrchestrationV2ThreadLaunchInput) =>
      Effect.sync(() => {
        input.launches?.push(launchInput);
        return {
          threadId: launchInput.threadId ?? v2ThreadId,
          projection: input.projection ?? v2Projection,
          resumed: false,
        };
      }),
    [WS_METHODS.projectsMutate]: (mutation: ProjectMutation) =>
      Effect.sync(() => {
        input.projects.push(mutation);
        return {
          id: mutation.projectId,
          title: mutation.type === "project.create" ? mutation.title : "Project",
          workspaceRoot:
            mutation.type === "project.create" ? mutation.workspaceRoot : "/workspace/project",
          repositoryIdentity: null,
          faviconPath: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-06-06T00:00:00.000Z",
          updatedAt: "2026-06-06T00:00:00.000Z",
          deletedAt: null,
        };
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession.RpcSession = {
    client,
    initialConfig: Effect.succeed({
      environment: {
        capabilities: {
          repositoryIdentity: true,
          ...(input.advertiseServerResolvedCommandContext === false
            ? {}
            : { serverResolvedCommandContext: true }),
        },
      },
    } as never),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  return EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(CONNECTED_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
});

describe("V2 environment commands", () => {
  it.effect("routes projects through the event-sourced project transport", () =>
    Effect.gen(function* () {
      const projects: ProjectMutation[] = [];
      const supervisor = yield* makeSupervisor({ commands: [], projects });

      yield* createProject({
        projectId: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/workspace/project",
        createWorkspaceRootIfMissing: true,
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(projects).toEqual([
        {
          type: "project.create",
          commandId: "00000000-0000-4000-8000-000000000000",
          projectId: "project-1",
          title: "Project",
          workspaceRoot: "/workspace/project",
          createWorkspaceRootIfMissing: true,
        },
      ]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("persists and clears project presentation and environment settings", () =>
    Effect.gen(function* () {
      const projects: ProjectMutation[] = [];
      const supervisor = yield* makeSupervisor({ commands: [], projects });
      const projectId = ProjectId.make("project-1");
      const projectIcon = { kind: "emoji", emoji: "🌲" } as const;
      yield* updateProject({
        projectId,
        autoPull: true,
        projectIcon,
        faviconPath: "/workspace/project/icon.png",
        defaultThreadEnvMode: "worktree",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
      yield* updateProject({
        projectId,
        autoPull: false,
        projectIcon: null,
        faviconPath: null,
        defaultThreadEnvMode: null,
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(projects).toEqual([
        {
          type: "project.update",
          commandId: "00000000-0000-4000-8000-000000000000",
          projectId,
          autoPull: true,
          projectIcon,
          faviconPath: "/workspace/project/icon.png",
          defaultThreadEnvMode: "worktree",
        },
        {
          type: "project.update",
          commandId: "00000000-0000-4000-8000-000000000000",
          projectId,
          autoPull: false,
          projectIcon: null,
          faviconPath: null,
          defaultThreadEnvMode: null,
        },
      ]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("preserves caller command ids for idempotent V2 commands", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });

      yield* archiveThread({
        commandId: CommandId.make("queued-command"),
        threadId: ThreadId.make("thread-1"),
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(commands).toEqual([
        { type: "thread.archive", commandId: "queued-command", threadId: "thread-1" },
      ]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("resolves run ordinal zero to the persisted thread-start checkpoint", () =>
    Effect.gen(function* () {
      const scopeId = CheckpointScopeId.make("checkpoint-scope-root");
      const checkpointId = CheckpointId.make("checkpoint-thread-start");
      const projection: OrchestrationV2ThreadProjection = {
        ...v2Projection,
        checkpoints: [
          {
            id: checkpointId,
            threadId: v2ThreadId,
            scopeId,
            runId: null,
            nodeId: NodeId.make("node-run-1"),
            parentCheckpointId: null,
            ordinalWithinScope: 0,
            appRunOrdinal: null,
            ref: CheckpointRef.make("refs/t3/thread-start"),
            status: "ready",
            files: [],
            capturedAt: v2Now,
          },
        ],
      };
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [], projection });

      yield* revertThreadCheckpoint({
        commandId: CommandId.make("rollback-thread-start"),
        threadId: v2ThreadId,
        turnCount: 0,
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(commands).toEqual([
        {
          type: "checkpoint.rollback",
          commandId: "rollback-thread-start",
          threadId: v2ThreadId,
          scopeId,
          checkpointId,
        },
      ]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect.each(
    (["web", "mobile"] as const).flatMap((creationSource) =>
      (["start", "auto", "queue", "steer"] as const).map((dispatchMode) => ({
        creationSource,
        dispatchMode,
      })),
    ),
  )(
    "keeps debug context for $creationSource $dispatchMode delivery",
    ({ creationSource, dispatchMode }) =>
      Effect.gen(function* () {
        const commands: OrchestrationV2Command[] = [];
        const supervisor = yield* makeSupervisor({ commands, projects: [] });
        yield* startThreadTurn({
          commandId: CommandId.make("debug-send"),
          creationSource,
          threadId: v2ThreadId,
          message: {
            messageId: MessageId.make("debug-message"),
            role: "user",
            text: "/debug stale phone",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          dispatchMode,
        }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
        expect(commands[0]).toMatchObject({
          type: "message.dispatch",
          ...expandDebugCommand("/debug stale phone"),
        });
        const sent = commands[0];
        if (sent?.type !== "message.dispatch") throw new Error("Expected a message");
        expect(sent.text).not.toContain("Debug workflow:");
        expect(
          projectComposerContextForProvider({
            text: sent.text,
            records: sent.context?.records ?? [],
          }),
        ).toContain("Reproduce it now, then pick Done");
        yield* startThreadTurn({
          commandId: CommandId.make("normal-send"),
          threadId: v2ThreadId,
          message: {
            messageId: MessageId.make("normal-message"),
            role: "user",
            text: "ordinary followup",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
        }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
        expect(commands[1]).toMatchObject({ text: "ordinary followup" });
      }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect.each(["web", "mobile"] as const)(
    "keeps debug context in a %s bootstrap launch",
    (creationSource) =>
      Effect.gen(function* () {
        const launches: OrchestrationV2ThreadLaunchInput[] = [];
        const supervisor = yield* makeSupervisor({ commands: [], projects: [], launches });
        yield* startThreadTurn({
          commandId: CommandId.make("bootstrap-debug"),
          creationSource,
          threadId: v2ThreadId,
          message: {
            messageId: MessageId.make("bootstrap-debug-message"),
            role: "user",
            text: "/debug stale phone",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          bootstrap: {
            createThread: {
              projectId: v2Projection.thread.projectId,
              title: "Debug",
              modelSelection: v2Projection.thread.modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt: "2026-11-06T00:00:00.000Z",
            },
          },
        }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
        expect(launches[0]?.initialMessage).toMatchObject(expandDebugCommand("/debug stale phone"));
        expect(JSON.stringify(launches[0])).not.toContain("Debug workflow:");
      }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("expands debug when editing a queued message", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });
      yield* editQueuedRun({
        commandId: CommandId.make("debug-edit"),
        threadId: v2ThreadId,
        runId: RunId.make("queued"),
        text: "/debug missed event",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
      expect(commands[0]).toMatchObject({
        type: "queued-run.edit",
        ...expandDebugCommand("/debug missed event"),
      });
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect.each([false, true])(
    "preserves existing context when editing queued debug (full edit: %s)",
    (fullEdit) =>
      Effect.gen(function* () {
        const runId = RunId.make("queued-debug");
        const messageId = MessageId.make("queued-debug-message");
        const mention = {
          version: 1 as const,
          kind: "mention" as const,
          contextId: ComposerContextId.make("source"),
          label: "index.ts",
          path: "index.ts",
        };
        const original = expandDebugCommand("/debug old description", {
          version: 1,
          records: [mention],
        });
        const projection = {
          ...v2Projection,
          runs: [{ id: runId, userMessageId: messageId }],
          messages: [{ id: messageId, text: original.text, context: original.context }],
        } as unknown as OrchestrationV2ThreadProjection;
        const commands: OrchestrationV2Command[] = [];
        const supervisor = yield* makeSupervisor({ commands, projects: [], projection });
        const text = fullEdit
          ? original.text.replace("old description", "new description")
          : "/debug new description";
        yield* editQueuedRun({
          commandId: CommandId.make("preserve-debug"),
          threadId: v2ThreadId,
          runId,
          text,
          ...(fullEdit
            ? {
                edit: {
                  messageId,
                  attachments: [],
                  context: { version: 1 as const, records: [mention] },
                },
              }
            : {}),
        }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
        const edited = commands[0];
        if (edited?.type !== "queued-run.edit") throw new Error("Expected queued edit");
        expect(edited.context?.records).toEqual(
          expect.arrayContaining([mention, expect.objectContaining({ kind: "debug" })]),
        );
        expect(edited.context?.records).toHaveLength(2);
        expect(edited.text).not.toContain("Debug workflow:");
        expect(
          projectComposerContextForProvider({
            text: edited.text,
            records: edited.context?.records ?? [],
          }).match(/Debug workflow:/g),
        ).toHaveLength(1);
      }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("preserves plan implementation provenance on V2 runs", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });

      yield* startThreadTurn({
        commandId: CommandId.make("implement-plan"),
        threadId: v2ThreadId,
        message: {
          messageId: MessageId.make("message-implementation"),
          role: "user",
          text: "Implement the plan",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        titleSeed: "Implement the plan",
        sourceProposedPlan: {
          threadId: ThreadId.make("thread-plan"),
          planId: PlanId.make("plan-1"),
        },
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        type: "message.dispatch",
        commandId: "implement-plan",
        threadId: v2ThreadId,
        titleSeed: "Implement the plan",
        sourcePlanRef: { threadId: "thread-plan", planId: "plan-1" },
        deliveryIntent: "auto",
        dispatchMode: { type: "start_immediately" },
      });
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect.each([false, true])(
    "launches comparison members through workspace preparation (Git: %s)",
    (isGitRepo) =>
      Effect.gen(function* () {
        const launches: OrchestrationV2ThreadLaunchInput[] = [];
        const supervisor = yield* makeSupervisor({ commands: [], projects: [], launches });
        const message = {
          role: "user" as const,
          text: "Build this [design](t3-context://v1/file/design)",
          attachments: [
            {
              type: "image" as const,
              id: "design",
              name: "design.png",
              mimeType: "image/png",
              sizeBytes: 10,
            },
          ],
          context: {
            version: 1 as const,
            records: [
              {
                version: 1 as const,
                contextId: ComposerContextId.make("design"),
                kind: "file" as const,
                label: "design.png",
                attachmentId: "design",
                name: "design.png",
                mimeType: "image/png",
                sizeBytes: 10,
              },
            ],
          },
        };
        for (const model of ["first-model", "second-model"]) {
          yield* startThreadTurn(
            comparisonThreadInput({
              projectId: ProjectId.make("comparison-project"),
              workspaceRoot: isGitRepo ? "/repo" : "/scratch",
              title: "Build a tool",
              isGitRepo,
              baseBranch: isGitRepo ? "main" : null,
              turn: {
                commandId: CommandId.make(`compare:${model}`),
                threadId: ThreadId.make(`compare:${model}`),
                message: { ...message, messageId: MessageId.make(`compare:${model}`) },
                modelSelection: { instanceId: ProviderInstanceId.make("codex"), model },
                runtimeMode: "full-access",
                interactionMode: "default",
                createdAt: "2026-10-27T12:00:00.000Z",
              },
            }),
          ).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
        }
        expect(launches).toHaveLength(2);
        expect(new Set(launches.map((launch) => launch.threadId)).size).toBe(2);
        expect(launches.map((launch) => launch.modelSelection.model)).toEqual([
          "first-model",
          "second-model",
        ]);
        for (const launch of launches) {
          expect(launch).toMatchObject({
            projectId: "comparison-project",
            workspaceStrategy: isGitRepo ? { type: "worktree", baseRef: "main" } : { type: "root" },
            initialMessage: {
              text: message.text,
              attachments: message.attachments,
              context: message.context,
            },
          });
          expect(launch.reuseExistingThread).toBeUndefined();
        }
      }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("preserves an existing worktree and branch during first-message launch", () =>
    Effect.gen(function* () {
      const launches: OrchestrationV2ThreadLaunchInput[] = [];
      const supervisor = yield* makeSupervisor({ commands: [], projects: [], launches });

      yield* startThreadTurn({
        commandId: CommandId.make("launch-existing-worktree"),
        threadId: v2ThreadId,
        message: {
          messageId: MessageId.make("message-existing-worktree"),
          role: "user",
          text: "Continue here",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        titleSeed: "Continue here",
        bootstrap: {
          createThread: {
            projectId: ProjectId.make("project-1"),
            title: "Thread",
            modelSelection: v2Projection.thread.modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "feature",
            worktreePath: "/workspace/project-worktrees/feature",
            createdAt: "2026-06-20T00:00:00.000Z",
          },
        },
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(launches[0]).toMatchObject({
        threadId: v2ThreadId,
        title: "Continue here",
        generateTitle: true,
        workspaceStrategy: {
          type: "existing_worktree",
          worktreePath: "/workspace/project-worktrees/feature",
          branch: "feature",
        },
      });
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("provisions an origin-based worktree for an existing empty thread", () =>
    Effect.gen(function* () {
      const launches: OrchestrationV2ThreadLaunchInput[] = [];
      const supervisor = yield* makeSupervisor({ commands: [], projects: [], launches });

      yield* startThreadTurn({
        commandId: CommandId.make("launch-existing-thread-worktree"),
        threadId: v2ThreadId,
        message: {
          messageId: MessageId.make("message-existing-thread-worktree"),
          role: "user",
          text: "Move to a worktree",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        bootstrap: {
          prepareWorktree: {
            projectCwd: "/workspace/project",
            baseBranch: "main",
            branch: "feature",
            startFromOrigin: true,
          },
        },
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(launches[0]).toMatchObject({
        threadId: v2ThreadId,
        reuseExistingThread: true,
        projectId: v2Projection.thread.projectId,
        workspaceStrategy: {
          type: "worktree",
          baseRef: "main",
          branch: "feature",
          startFromOrigin: true,
        },
      });
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("uses server-resolved delivery intent without fetching the full projection", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const projectionRequests: ThreadId[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [], projectionRequests });

      for (const [mode, expectedType] of [
        ["queue", "queue_after_active"],
        ["auto", "start_immediately"],
        ["steer", "start_immediately"],
        ["restart", "start_immediately"],
      ] as const) {
        yield* startThreadTurn({
          commandId: CommandId.make(`command-${mode}`),
          threadId: v2ThreadId,
          message: {
            messageId: MessageId.make(`message-${mode}`),
            role: "user",
            text: mode,
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          dispatchMode: mode,
        }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

        expect(commands.at(-1)).toMatchObject({
          type: "message.dispatch",
          dispatchMode: { type: expectedType },
          ...(mode === "queue" ? {} : { deliveryIntent: mode }),
        });
      }
      expect(projectionRequests).toEqual([]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect.each([
    { driver: "antigravity", native: false, interrupt: true, expected: "steer_active" },
    { driver: "antigravity", native: true, interrupt: true, expected: "steer_active" },
    { driver: "antigravity", native: false, interrupt: false, expected: "queue_after_active" },
    { driver: "acpRegistry", native: false, interrupt: true, expected: "queue_after_active" },
  ])("routes composer delivery for $driver (native=$native, interrupt=$interrupt)", (test) =>
    Effect.gen(function* () {
      const activeRunId = RunId.make("fallback-active-run");
      const projection = {
        ...v2Projection,
        runs: [{ id: activeRunId, status: "running", providerThreadId: "fallback-thread" }],
        providerThreads: [{ id: "fallback-thread", providerSessionId: "fallback-session" }],
        providerSessions: [
          {
            id: "fallback-session",
            driver: test.driver,
            capabilities: {
              turns: {
                supportsActiveSteering: test.native,
                supportsInterrupt: test.interrupt,
                supportsSteeringByInterruptRestart: true,
              },
            },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({
        commands,
        projects: [],
        projection,
        advertiseServerResolvedCommandContext: false,
      });
      for (const dispatchMode of ["auto", "steer"] as const) {
        yield* startThreadTurn({
          commandId: CommandId.make(`fallback-${test.driver}-${dispatchMode}`),
          threadId: v2ThreadId,
          message: {
            messageId: MessageId.make(`fallback-${dispatchMode}`),
            role: "user",
            text: "new direction",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          dispatchMode,
        }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
        const type = dispatchMode === "steer" ? "steer_active" : test.expected;
        expect(commands.at(-1)).toMatchObject({
          dispatchMode: {
            type,
            ...(type === "steer_active" ? { targetRunId: activeRunId } : {}),
          },
        });
      }
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("retains projection-shaped delivery for servers without command context support", () =>
    Effect.gen(function* () {
      const activeRunId = RunId.make("legacy-active-run");
      const projection: OrchestrationV2ThreadProjection = {
        ...v2Projection,
        runs: [
          {
            id: activeRunId,
            threadId: v2ThreadId,
            ordinal: 1,
            providerInstanceId: v2Projection.thread.providerInstanceId,
            modelSelection: v2Projection.thread.modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("legacy-active-message"),
            rootNodeId: null,
            activeAttemptId: null,
            status: "running",
            requestedAt: v2Now,
            startedAt: v2Now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        ],
      };
      const commands: OrchestrationV2Command[] = [];
      const projectionRequests: ThreadId[] = [];
      const supervisor = yield* makeSupervisor({
        commands,
        projects: [],
        projection,
        projectionRequests,
        advertiseServerResolvedCommandContext: false,
      });

      for (const [mode, expectedMode] of [
        ["auto", { type: "queue_after_active" }],
        ["queue", { type: "queue_after_active" }],
        ["steer", { type: "steer_active", targetRunId: activeRunId }],
        ["restart", { type: "restart_active", targetRunId: activeRunId }],
      ] as const) {
        yield* startThreadTurn({
          commandId: CommandId.make(`legacy-command-${mode}`),
          threadId: v2ThreadId,
          message: {
            messageId: MessageId.make(`legacy-message-${mode}`),
            role: "user",
            text: mode,
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          dispatchMode: mode,
        }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

        expect(commands.at(-1)).toMatchObject({
          type: "message.dispatch",
          dispatchMode: expectedMode,
        });
        expect(commands.at(-1)).not.toHaveProperty("deliveryIntent");
      }
      expect(projectionRequests).toEqual([v2ThreadId, v2ThreadId, v2ThreadId, v2ThreadId]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect.each(["failed", "cancelled"] as const)(
    "web thread-only Stop dispatches cancellation for a %s pending retry",
    (status) =>
      Effect.gen(function* () {
        const runId = RunId.make("pending-provider-retry");
        const projection: OrchestrationV2ThreadProjection = {
          ...v2Projection,
          runs: [
            {
              id: runId,
              threadId: v2ThreadId,
              ordinal: 1,
              providerInstanceId: v2Projection.thread.providerInstanceId,
              modelSelection: v2Projection.thread.modelSelection,
              providerThreadId: null,
              userMessageId: MessageId.make("pending-provider-retry"),
              rootNodeId: null,
              activeAttemptId: null,
              status,
              requestedAt: v2Now,
              startedAt: v2Now,
              completedAt: v2Now,
              checkpointId: null,
              contextHandoffId: null,
              automaticProviderRetry: {
                attempt: 1,
                status: "scheduled",
                scheduledAt: "2026-06-20T00:00:05.000Z",
              },
            },
          ],
        };
        const commands: OrchestrationV2Command[] = [];
        const supervisor = yield* makeSupervisor({ commands, projects: [], projection });
        yield* interruptThreadTurn({ threadId: v2ThreadId }).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        );
        expect(commands).toEqual([
          {
            type: "run.interrupt",
            commandId: expect.any(String),
            threadId: v2ThreadId,
            runId,
            holdQueue: true,
          },
        ]);
      }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("Stop reply sends a scoped interrupt without holding the queue", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });
      const runId = RunId.make("run:stop-reply");
      yield* interruptThreadTurn({ threadId: v2ThreadId, runId, keepHelpers: true }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      );
      expect(commands).toEqual([
        {
          type: "run.interrupt",
          commandId: expect.any(String),
          threadId: v2ThreadId,
          runId,
          keepHelpers: true,
        },
      ]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("Stop reply with no active reply leaves helpers alone", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({
        commands,
        projects: [],
        projection: {
          ...v2Projection,
          runs: [],
        },
      });
      yield* interruptThreadTurn({ threadId: v2ThreadId, keepHelpers: true }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      );
      expect(commands).toEqual([]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("Stop with no run left ends the thread's pull request watches", () =>
    Effect.gen(function* () {
      const link = {
        host: "github.com",
        repository: "pingdotgg/t3code",
        url: "https://github.com/pingdotgg/t3code/pull/7",
        source: "agent" as const,
        linkedAt: "2026-10-05T00:00:00.000Z",
        snapshot: null,
        stack: null,
      };
      const watch = {
        startedAt: "2026-10-05T00:00:00.000Z",
        headSha: null,
        failedChecks: [],
        passed: false,
        passedChecks: [],
        remarksThrough: "2026-10-05T00:00:00.000Z",
        remarkIds: [],
        conflicting: false,
        wakes: 0,
      };
      const projection: OrchestrationV2ThreadProjection = {
        ...v2Projection,
        thread: {
          ...v2Projection.thread,
          pullRequests: [
            { ...link, number: 7, watch },
            { ...link, number: 8 },
            { ...link, number: 9, source: "stack-dismissed", watch },
          ],
        },
      };
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [], projection });

      yield* interruptThreadTurn({ threadId: v2ThreadId }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      );

      expect(commands).toEqual([
        {
          type: "thread.pull-request.watch",
          commandId: expect.any(String),
          threadId: v2ThreadId,
          host: "github.com",
          repository: "pingdotgg/t3code",
          number: 7,
          watching: false,
        },
      ]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect.each(["cancelled", "queued", "subagent"] as const)(
    "stops background work with a %s follow-up or child",
    (scenario) =>
      Effect.gen(function* () {
        const waitingRunId = RunId.make("run-waiting");
        const executed = {
          id: waitingRunId,
          threadId: v2ThreadId,
          ordinal: 1,
          providerInstanceId: v2Projection.thread.providerInstanceId,
          modelSelection: v2Projection.thread.modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message-waiting"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed" as const,
          requestedAt: v2Now,
          startedAt: v2Now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        };
        const commands: OrchestrationV2Command[] = [];
        const projection: OrchestrationV2ThreadProjection = {
          ...v2Projection,
          runs:
            scenario === "subagent"
              ? [executed]
              : [
                  executed,
                  {
                    ...executed,
                    id: RunId.make("follow-up"),
                    ordinal: 2,
                    startedAt: null,
                    status: scenario,
                    queueHeld: scenario === "queued",
                  },
                ],
          turnItems:
            scenario === "subagent"
              ? []
              : [
                  {
                    id: TurnItemId.make("background-command"),
                    threadId: v2ThreadId,
                    runId: waitingRunId,
                    nodeId: null,
                    providerThreadId: null,
                    providerTurnId: null,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: 1,
                    status: "running",
                    title: null,
                    startedAt: v2Now,
                    completedAt: null,
                    updatedAt: v2Now,
                    type: "command_execution",
                    input: "vp run dev",
                  },
                ],
          subagents:
            scenario !== "subagent"
              ? []
              : [
                  {
                    id: NodeId.make("child-node"),
                    threadId: v2ThreadId,
                    runId: waitingRunId,
                    parentNodeId: NodeId.make("owner-node"),
                    origin: "app_owned",
                    createdBy: "agent",
                    driver: ProviderDriverKind.make("claudeAgent"),
                    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
                    providerThreadId: null,
                    childThreadId: ThreadId.make("native-child-thread"),
                    nativeTaskRef: null,
                    prompt: "Work",
                    title: null,
                    model: null,
                    result: null,
                    status: "running",
                    startedAt: v2Now,
                    completedAt: null,
                    updatedAt: v2Now,
                  },
                ],
        };
        const supervisor = yield* makeSupervisor({ commands, projects: [], projection });
        yield* interruptThreadTurn({ threadId: v2ThreadId }).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        );
        expect(commands).toMatchObject([
          { type: "run.interrupt", runId: waitingRunId, holdQueue: true },
        ]);
      }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect.each([
    "waiting",
    "completed",
    "failed",
    "interrupted",
    "cancelled",
    "rolled_back",
  ] as const)("dispatches Stop for %s runs with background commands except rollback", (status) =>
    Effect.gen(function* () {
      const waitingRunId = RunId.make("run-waiting");
      const projection: OrchestrationV2ThreadProjection = {
        ...v2Projection,
        runs: [
          {
            id: waitingRunId,
            threadId: v2ThreadId,
            ordinal: 1,
            providerInstanceId: v2Projection.thread.providerInstanceId,
            modelSelection: v2Projection.thread.modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("message-waiting"),
            rootNodeId: null,
            activeAttemptId: null,
            status,
            requestedAt: v2Now,
            startedAt: v2Now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        ],
        turnItems: [
          {
            id: TurnItemId.make("background-command"),
            threadId: v2ThreadId,
            runId: waitingRunId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "running",
            title: null,
            startedAt: v2Now,
            completedAt: null,
            updatedAt: v2Now,
            type: "command_execution",
            input: "vp run dev",
          },
        ],
      };
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [], projection });

      const result = yield* interruptThreadTurn({ threadId: v2ThreadId }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      );

      expect(result).toEqual({ sequence: status === "rolled_back" ? 0 : 1 });
      expect(commands).toEqual(
        status === "rolled_back"
          ? []
          : [
              {
                type: "run.interrupt",
                commandId: expect.any(String),
                threadId: v2ThreadId,
                runId: waitingRunId,
                holdQueue: true,
              },
            ],
      );
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect(
    "dispatches V2-native relationship and queue commands without compatibility shaping",
    () =>
      Effect.gen(function* () {
        const commands: OrchestrationV2Command[] = [];
        const supervisor = yield* makeSupervisor({ commands, projects: [] });
        const provide = Effect.provideService(
          EnvironmentSupervisor.EnvironmentSupervisor,
          supervisor,
        );

        yield* forkThreadFromRun({
          commandId: CommandId.make("fork"),
          sourceThreadId: v2ThreadId,
          targetThreadId: ThreadId.make("thread-fork"),
          runId: RunId.make("run-1"),
        }).pipe(provide);
        yield* mergeThreadBack({
          commandId: CommandId.make("merge"),
          sourceThreadId: ThreadId.make("thread-fork"),
          targetThreadId: v2ThreadId,
          runId: RunId.make("run-2"),
        }).pipe(provide);
        yield* reorderQueuedRun({
          commandId: CommandId.make("reorder"),
          threadId: v2ThreadId,
          runId: RunId.make("run-3"),
          beforeRunId: RunId.make("run-4"),
        }).pipe(provide);
        yield* promoteQueuedRun({
          commandId: CommandId.make("promote"),
          threadId: v2ThreadId,
          queuedRunId: RunId.make("run-3"),
          targetRunId: RunId.make("run-active"),
        }).pipe(provide);
        yield* cancelQueuedRun({
          commandId: CommandId.make("cancel"),
          threadId: v2ThreadId,
          runId: RunId.make("run-3"),
        }).pipe(provide);
        yield* editQueuedRun({
          commandId: CommandId.make("edit"),
          threadId: v2ThreadId,
          runId: RunId.make("run-3"),
          text: "updated queued text",
        }).pipe(provide);
        yield* editQueuedRun({
          commandId: CommandId.make("edit-attachments"),
          threadId: v2ThreadId,
          runId: RunId.make("run-3"),
          text: "updated queued text with attachments",
          edit: {
            messageId: MessageId.make("message-3"),
            attachments: [
              {
                type: "image",
                id: "attachment-kept",
                name: "kept.png",
                mimeType: "image/png",
                sizeBytes: 64,
              },
            ],
          },
        }).pipe(provide);

        expect(commands).toMatchObject([
          { type: "thread.fork", sourcePoint: { type: "run", runId: "run-1" } },
          { type: "thread.merge_back", sourcePoint: { type: "run", runId: "run-2" } },
          { type: "queued-run.reorder", runId: "run-3", beforeRunId: "run-4" },
          {
            type: "queued-message.promote-to-steer",
            queuedRunId: "run-3",
            targetRunId: "run-active",
          },
          { type: "queued-run.cancel", runId: "run-3" },
          { type: "queued-run.edit", runId: "run-3", text: "updated queued text" },
          {
            type: "queued-run.edit",
            runId: "run-3",
            text: "updated queued text with attachments",
            attachments: [{ id: "attachment-kept" }],
          },
        ]);
        // A text-only edit must not send an attachments replacement list.
        expect(commands[5]).not.toHaveProperty("attachments");
      }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("delegates model selection to the server without fetching the full projection", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const projectionRequests: ThreadId[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [], projectionRequests });

      yield* updateThreadMetadata({
        commandId: CommandId.make("same-provider"),
        threadId: v2ThreadId,
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "another-model",
        },
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      yield* updateThreadMetadata({
        commandId: CommandId.make("switch-provider"),
        threadId: v2ThreadId,
        modelSelection: {
          instanceId: ProviderInstanceId.make("claude"),
          model: "claude-sonnet-4-6",
        },
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(commands).toEqual([
        {
          type: "thread.model-selection.set",
          commandId: "same-provider",
          threadId: v2ThreadId,
          modelSelection: { instanceId: "codex", model: "another-model" },
        },
        {
          type: "thread.model-selection.set",
          commandId: "switch-provider",
          threadId: v2ThreadId,
          modelSelection: { instanceId: "claude", model: "claude-sonnet-4-6" },
        },
      ]);
      expect(projectionRequests).toEqual([]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("retains provider-switch shaping for servers without command context support", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const projectionRequests: ThreadId[] = [];
      const supervisor = yield* makeSupervisor({
        commands,
        projects: [],
        projectionRequests,
        advertiseServerResolvedCommandContext: false,
      });

      yield* updateThreadMetadata({
        commandId: CommandId.make("legacy-switch-provider"),
        threadId: v2ThreadId,
        modelSelection: {
          instanceId: ProviderInstanceId.make("claude"),
          model: "claude-sonnet-4-6",
        },
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(projectionRequests).toEqual([v2ThreadId]);
      expect(commands).toEqual([
        {
          type: "provider.switch",
          commandId: "legacy-switch-provider",
          threadId: v2ThreadId,
          modelSelection: { instanceId: "claude", model: "claude-sonnet-4-6" },
        },
      ]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect.each([true, false])(
    "rolls back an identified checkpoint without fetching the full projection, restoreFiles=%s",
    (restoreFiles) =>
      Effect.gen(function* () {
        const commands: OrchestrationV2Command[] = [];
        const projectionRequests: ThreadId[] = [];
        const supervisor = yield* makeSupervisor({ commands, projects: [], projectionRequests });

        yield* revertThreadCheckpoint({
          commandId: CommandId.make("rollback-known-checkpoint"),
          threadId: v2ThreadId,
          checkpointId: CheckpointId.make("checkpoint-known"),
          scopeId: CheckpointScopeId.make("scope-known"),
          restoreFiles,
        }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

        expect(projectionRequests).toEqual([]);
        expect(commands).toEqual([
          {
            type: "checkpoint.rollback",
            commandId: "rollback-known-checkpoint",
            threadId: v2ThreadId,
            checkpointId: "checkpoint-known",
            scopeId: "scope-known",
            restoreFiles,
          },
        ]);
      }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("validates identified checkpoints locally for older servers", () =>
    Effect.gen(function* () {
      const checkpointId = CheckpointId.make("legacy-checkpoint");
      const scopeId = CheckpointScopeId.make("legacy-checkpoint-scope");
      for (const status of ["ready", "missing", "error", "stale", null] as const) {
        const commands: OrchestrationV2Command[] = [];
        const projectionRequests: ThreadId[] = [];
        const supervisor = yield* makeSupervisor({
          commands,
          projects: [],
          projectionRequests,
          advertiseServerResolvedCommandContext: false,
          projection: {
            ...v2Projection,
            checkpoints:
              status === null
                ? []
                : [
                    {
                      id: checkpointId,
                      threadId: v2ThreadId,
                      scopeId,
                      runId: null,
                      nodeId: NodeId.make("legacy-checkpoint-node"),
                      parentCheckpointId: null,
                      ordinalWithinScope: 0,
                      appRunOrdinal: null,
                      ref: CheckpointRef.make("refs/t3/legacy-checkpoint"),
                      status,
                      files: [],
                      capturedAt: v2Now,
                    },
                  ],
          },
        });
        const rollback = revertThreadCheckpoint({
          commandId: CommandId.make(`legacy-rollback-${status}`),
          threadId: v2ThreadId,
          checkpointId,
          scopeId,
        }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

        // A missing checkpoint (no git) still rewinds the conversation.
        if (status === "ready" || status === "missing") {
          yield* rollback;
          expect(commands).toEqual([
            {
              type: "checkpoint.rollback",
              commandId: `legacy-rollback-${status}`,
              threadId: v2ThreadId,
              checkpointId,
              scopeId,
            },
          ]);
        } else {
          const error = yield* rollback.pipe(Effect.flip);
          expect(error._tag).toBe("OrchestrationV2CheckpointUnavailableError");
          expect(commands).toEqual([]);
        }
        expect(projectionRequests).toEqual([v2ThreadId]);
      }
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("dispatches settle and unsettle commands without timestamps", () =>
    Effect.gen(function* () {
      const dispatched: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands: dispatched, projects: [] });

      yield* settleThread({
        commandId: CommandId.make("settle-command"),
        threadId: ThreadId.make("thread-1"),
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
      yield* unsettleThread({
        commandId: CommandId.make("unsettle-command"),
        threadId: ThreadId.make("thread-1"),
        reason: "user",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(dispatched).toEqual([
        {
          type: "thread.settle",
          commandId: "settle-command",
          threadId: "thread-1",
        },
        {
          type: "thread.unsettle",
          commandId: "unsettle-command",
          threadId: "thread-1",
          reason: "user",
        },
      ]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("sends an active order key without changing activity timestamps", () =>
    Effect.gen(function* () {
      const dispatched: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands: dispatched, projects: [] });
      yield* reorderActiveThread({
        commandId: CommandId.make("reorder-command"),
        threadId: ThreadId.make("thread-1"),
        orderKey: "mf",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
      expect(dispatched).toEqual([
        {
          type: "thread.active.reorder",
          commandId: "reorder-command",
          threadId: "thread-1",
          orderKey: "mf",
        },
      ]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("dismisses a pending user-input request", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });

      yield* dismissThreadUserInput({
        commandId: CommandId.make("dismiss-command"),
        threadId: v2ThreadId,
        requestId: RuntimeRequestId.make("request-1"),
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(commands).toEqual([
        {
          type: "thread.user-input.dismiss",
          commandId: "dismiss-command",
          threadId: v2ThreadId,
          requestId: "request-1",
        },
      ]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  // A dead socket reaches the caller as a protocol error, or as an interrupt when
  // the supervisor closes the session before the protocol reports the error.
  it.effect.each([
    ["protocol error", Effect.suspend(() => Effect.fail(socketClosed()))],
    ["session close", Effect.failCause(Cause.interrupt())],
  ] as const)("retries a message dispatch lost to a %s with the same command id", ([, loss]) =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });
      const healthySession = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
      const firstAttemptLost = yield* Deferred.make<void>();
      const lostClient = {
        ...healthySession.client,
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
          Effect.gen(function* () {
            commands.push(command);
            yield* SubscriptionRef.set(supervisor.session, Option.none());
            yield* Deferred.succeed(firstAttemptLost, undefined);
            return yield* loss;
          }),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(
        supervisor.session,
        Option.some({ ...healthySession, client: lostClient }),
      );

      const sendFiber = yield* startThreadTurn(helloTurn("lost-ack", true)).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Deferred.await(firstAttemptLost);
      yield* SubscriptionRef.set(supervisor.session, Option.some(healthySession));
      const exit = yield* Fiber.await(sendFiber);

      expect(commands.map((command) => [command.type, command.commandId])).toEqual([
        ["message.dispatch", "command-lost-ack"],
        ["message.dispatch", "command-lost-ack"],
      ]);
      expect(Exit.isSuccess(exit)).toBe(true);
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("sends a turn tapped during backoff as soon as a session arrives", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });
      const session = yield* SubscriptionRef.get(supervisor.session);
      yield* SubscriptionRef.set(supervisor.state, {
        ...CONNECTED_STATE,
        phase: "backoff" as const,
      });
      yield* SubscriptionRef.set(supervisor.session, Option.none());
      const waiting = yield* startThreadTurn(helloTurn("reconnect", true)).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* TestClock.adjust("2 seconds");
      expect(commands).toHaveLength(0);
      yield* SubscriptionRef.set(supervisor.session, session);
      yield* Fiber.join(waiting);
      expect(commands.map((command) => command.commandId)).toEqual(["command-reconnect"]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect.each(["answer", "edit"] as const)(
    "replays a lost %s receipt once with exactly the same payload",
    (kind) =>
      Effect.gen(function* () {
        const commands: OrchestrationV2Command[] = [];
        const supervisor = yield* makeSupervisor({ commands, projects: [] });
        const healthy = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
        yield* SubscriptionRef.set(
          supervisor.session,
          Option.some({
            ...healthy,
            client: {
              ...healthy.client,
              [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command) =>
                Effect.gen(function* () {
                  commands.push(command as OrchestrationV2Command);
                  yield* SubscriptionRef.set(supervisor.session, Option.some(healthy));
                  return yield* socketClosed();
                }),
            },
          }),
        );
        const send =
          kind === "answer"
            ? respondToThreadUserInput({
                threadId: v2ThreadId,
                requestId: RuntimeRequestId.make("request"),
                answers: { question: "yes" },
                resendAfterSocketLoss: true,
              })
            : editQueuedRun({ threadId: v2ThreadId, runId: RunId.make("run"), text: "edited" });
        yield* send.pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        );
        expect(commands).toHaveLength(2);
        expect(commands[1]).toEqual(commands[0]);
      }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("replays a lost approval receipt once with exactly the same payload", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });
      const healthy = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
      yield* SubscriptionRef.set(
        supervisor.session,
        Option.some({
          ...healthy,
          client: {
            ...healthy.client,
            [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command) =>
              Effect.gen(function* () {
                commands.push(command as OrchestrationV2Command);
                yield* SubscriptionRef.set(supervisor.session, Option.some(healthy));
                return yield* socketClosed();
              }),
          },
        }),
      );

      yield* respondToThreadApproval({
        threadId: v2ThreadId,
        requestId: RuntimeRequestId.make("request"),
        decision: "accept",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(commands).toHaveLength(2);
      expect(commands[1]).toEqual(commands[0]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("releases a protocol failure when the same socket still answers", () =>
    Effect.gen(function* () {
      const supervisor = yield* makeSupervisor({ commands: [], projects: [] });
      const healthy = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
      yield* SubscriptionRef.set(
        supervisor.session,
        Option.some({
          ...healthy,
          client: {
            ...healthy.client,
            [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: () => Effect.fail(socketClosed()),
          },
        }),
      );
      const result = yield* startThreadTurn(helloTurn("protocol-error", true)).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
      );
      expect(result._tag).toBe("RpcClientError");
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("reuses an identified command if a slow probe leaves the same session open", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });
      const healthy = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
      const client = {
        ...healthy.client,
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
          Effect.suspend(() => {
            if (commands.length > 0)
              return healthy.client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](command);
            commands.push(command);
            return Effect.fail(socketClosed());
          }),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(
        supervisor.session,
        Option.some({ ...healthy, client, probe: Effect.sleep("4 seconds") }),
      );
      const sending = yield* startThreadTurn(helloTurn("slow-probe", true)).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* TestClock.adjust("2999 millis");
      expect(commands).toHaveLength(1);
      yield* TestClock.adjust("1 milli");
      yield* Fiber.join(sending);
      expect(commands).toHaveLength(2);
      expect(commands[1]).toEqual(commands[0]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("releases an offline composer after five minutes without a session", () =>
    Effect.gen(function* () {
      const supervisor = yield* makeSupervisor({ commands: [], projects: [] });
      yield* SubscriptionRef.set(supervisor.session, Option.none());
      yield* SubscriptionRef.set(supervisor.state, {
        ...CONNECTED_STATE,
        phase: "offline" as const,
      });
      const waiting = yield* startThreadTurn(helloTurn("offline", true)).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust("299999 millis");
      expect(waiting.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 milli");
      expect((yield* Fiber.join(waiting))._tag).toBe("EnvironmentRpcUnavailableError");
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("stops resending a message whose dispatch keeps losing the socket", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });
      const healthySession = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
      const dyingClient: WsRpcProtocolClient = {
        ...healthySession.client,
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
          Effect.gen(function* () {
            commands.push(command);
            yield* SubscriptionRef.set(
              supervisor.session,
              Option.some({ ...healthySession, client: dyingClient }),
            );
            return yield* socketClosed();
          }),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(
        supervisor.session,
        Option.some({ ...healthySession, client: dyingClient }),
      );

      const error = yield* startThreadTurn(helloTurn("socket-killer", true)).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
      );

      expect(commands.map((command) => command.commandId)).toEqual([
        "command-socket-killer",
        "command-socket-killer",
        "command-socket-killer",
      ]);
      expect(error._tag).toBe("RpcClientError");
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("bounds unanswered phone and web dispatches on a live socket", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });
      const healthySession = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
      const silentClient = {
        ...healthySession.client,
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
          Effect.sync(() => commands.push(command)).pipe(Effect.andThen(Effect.never)),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(
        supervisor.session,
        Option.some({ ...healthySession, client: silentClient }),
      );
      const send = (id: string, resendAfterSocketLoss?: boolean) =>
        startThreadTurn(helloTurn(id, resendAfterSocketLoss)).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.flip,
          Effect.forkChild,
        );

      const optedIn = yield* send("unanswered", true);
      const phone = yield* send("phone");
      yield* TestClock.adjust("1 minute");

      expect((yield* Fiber.join(optedIn))._tag).toBe("EnvironmentRpcUnavailableError");
      expect(phone.pollUnsafe()).toBeDefined();
      expect((yield* Fiber.join(phone))._tag).toBe("EnvironmentRpcUnavailableError");
      expect(commands.map((command) => command.commandId)).toEqual([
        "command-unanswered",
        "command-phone",
      ]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("replays the same worktree launch after losing its acknowledgement", () =>
    Effect.gen(function* () {
      const launches: OrchestrationV2ThreadLaunchInput[] = [];
      const lost: Parameters<
        WsRpcProtocolClient[typeof ORCHESTRATION_V2_WS_METHODS.launchThread]
      >[0][] = [];
      const supervisor = yield* makeSupervisor({ launches, commands: [], projects: [] });
      const healthy = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
      yield* SubscriptionRef.set(
        supervisor.session,
        Option.some({
          ...healthy,
          client: {
            ...healthy.client,
            [ORCHESTRATION_V2_WS_METHODS.launchThread]: (launch) =>
              Effect.gen(function* () {
                lost.push(launch);
                yield* SubscriptionRef.set(supervisor.session, Option.some(healthy));
                return yield* socketClosed();
              }),
          },
        }),
      );
      const exit = yield* startThreadTurn({
        ...helloTurn("worktree", true),
        bootstrap: { prepareWorktree: { projectCwd: "/project", baseBranch: "main" } },
      }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.exit,
      );
      expect(lost).toHaveLength(1);
      expect(launches).toEqual(lost);
      expect(Exit.isSuccess(exit)).toBe(true);
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("releases an outbox send when preparation receives no projection", () =>
    Effect.gen(function* () {
      const supervisor = yield* makeSupervisor({ commands: [], projects: [] });
      const healthy = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
      yield* SubscriptionRef.set(
        supervisor.session,
        Option.some({
          ...healthy,
          client: {
            ...healthy.client,
            [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: () => Effect.never,
          },
        }),
      );
      const prepared = yield* prepareThreadTurn({
        ...helloTurn("prepare"),
        bootstrap: { prepareWorktree: { projectCwd: "/project", baseBranch: "main" } },
      }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust("1 minute");
      expect(prepared.pollUnsafe()).toBeDefined();
      expect((yield* Fiber.join(prepared))._tag).toBe("EnvironmentRpcUnavailableError");
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("holds a lost message through reconnect backoff until disconnect", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });
      const healthySession = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
      const lostClient = {
        ...healthySession.client,
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
          Effect.gen(function* () {
            commands.push(command);
            yield* SubscriptionRef.set(supervisor.session, Option.none());
            return yield* socketClosed();
          }),
      } as unknown as WsRpcProtocolClient;
      const send = (id: string, resendAfterSocketLoss?: boolean) =>
        Effect.gen(function* () {
          yield* SubscriptionRef.set(
            supervisor.session,
            Option.some({ ...healthySession, client: lostClient }),
          );
          return yield* startThreadTurn(helloTurn(id, resendAfterSocketLoss)).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.flip,
            Effect.forkChild,
          );
        });

      // Without the option a lost socket fails at once, as the phone's outbox expects.
      const phone = yield* send("host-gone-phone");
      expect((yield* Fiber.join(phone))._tag).toBe("RpcClientError");

      const waiting = yield* send("host-gone-web", true);
      yield* SubscriptionRef.set(supervisor.state, {
        ...CONNECTED_STATE,
        phase: "backoff" as const,
      });
      yield* TestClock.adjust("2 minutes");
      expect(waiting.pollUnsafe()).toBeUndefined();
      yield* SubscriptionRef.set(supervisor.state, AVAILABLE_CONNECTION_STATE);
      expect((yield* Fiber.join(waiting))._tag).toBe("RpcClientError");
      expect(commands.map((command) => command.commandId)).toEqual([
        "command-host-gone-phone",
        "command-host-gone-web",
      ]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("dispatches an explicit idle start without fetching the full projection", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const projectionRequests: ThreadId[] = [];
      const supervisor = yield* makeSupervisor({
        commands,
        projects: [],
        projectionRequests,
      });

      yield* startThreadTurn({
        commandId: CommandId.make("direct-start"),
        threadId: v2ThreadId,
        message: {
          messageId: MessageId.make("direct-start-message"),
          role: "user",
          text: "continue",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        dispatchMode: "start",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(projectionRequests).toEqual([]);
      expect(commands).toMatchObject([
        {
          type: "message.dispatch",
          threadId: v2ThreadId,
          dispatchMode: { type: "start_immediately" },
        },
      ]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect(
    "a native subagent stop targets its owning run rather than holding the parent queue",
    () =>
      Effect.gen(function* () {
        const subagentId = NodeId.make("native-subagent");
        const runId = RunId.make("settled-owner-run");
        const commands: OrchestrationV2Command[] = [];
        const supervisor = yield* makeSupervisor({
          commands,
          projects: [],
          projection: {
            ...v2Projection,
            subagents: [
              {
                id: subagentId,
                threadId: v2ThreadId,
                runId,
                parentNodeId: NodeId.make("owner-node"),
                origin: "provider_native",
                createdBy: "agent",
                driver: ProviderDriverKind.make("claudeAgent"),
                providerInstanceId: ProviderInstanceId.make("claudeAgent"),
                providerThreadId: null,
                childThreadId: ThreadId.make("native-child-thread"),
                nativeTaskRef: null,
                prompt: "Work",
                title: null,
                model: null,
                result: null,
                status: "running",
                startedAt: v2Now,
                completedAt: null,
                updatedAt: v2Now,
              },
            ],
          },
        });
        yield* interruptThreadTurn({
          commandId: CommandId.make("native-stop"),
          threadId: v2ThreadId,
          subagentId,
        }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
        expect(commands).toEqual([
          {
            type: "subagent.stop",
            commandId: "native-stop",
            threadId: v2ThreadId,
            runId,
            subagentId,
          },
        ]);
      }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("interrupts a known run without fetching the full projection", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const projectionRequests: ThreadId[] = [];
      const supervisor = yield* makeSupervisor({
        commands,
        projects: [],
        projectionRequests,
      });

      yield* interruptThreadTurn({
        commandId: CommandId.make("direct-interrupt"),
        threadId: v2ThreadId,
        runId: RunId.make("active-run"),
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(projectionRequests).toEqual([]);
      expect(commands).toEqual([
        {
          type: "run.interrupt",
          commandId: "direct-interrupt",
          threadId: v2ThreadId,
          runId: "active-run",
          holdQueue: true,
        },
      ]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );
});
