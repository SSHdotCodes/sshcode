import { AcpRequestError } from "effect-acp/errors";
import { CodexAppServerRequestError } from "effect-codex-app-server/errors";
import * as ChatControls from "../sessionBoxes/chatControls.ts";
import { expandDebugCommand } from "@t3tools/shared/debugCommand";
import * as TerminalHandoffState from "./TerminalHandoffState.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  CheckpointScopeId,
  ContextTransferId,
  MessageId,
  NodeId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
  RunAttemptId,
  RunId,
  ThreadId,
  ProjectId,
  type OrchestrationV2ThreadProjection,
  OrchestrationV2DomainEvent,
  TurnItemId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import { WORKSPACE_PREPARATION_INPUT } from "./workspacePreparation.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const isDomainEvent = Schema.is(OrchestrationV2DomainEvent);

it("does not commit running state when inherited background routing cannot be read", async () => {
  const threadId = ThreadId.make("thread_provider_turn_start_projection_failure");
  const runId = RunId.make("run_provider_turn_start_projection_failure");
  const attemptId = RunAttemptId.make("attempt_provider_turn_start_projection_failure");
  const rootNodeId = NodeId.make("node_provider_turn_start_projection_failure");
  const providerThreadId = ProviderThreadId.make(
    "provider_thread_provider_turn_start_projection_failure",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider_session_provider_turn_start_projection_failure",
  );
  const messageId = MessageId.make("message_provider_turn_start_projection_failure");
  const checkpointScopeId = CheckpointScopeId.make(
    "checkpoint_scope_provider_turn_start_projection_failure",
  );
  const projection = {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project_provider_turn_start_projection_failure"),
      branch: "feature/restore",
      worktreePath: "/tmp/missing-provider-turn-start-worktree",
    },
    runs: [
      {
        id: runId,
        status: "starting",
        rootNodeId,
        activeAttemptId: attemptId,
        providerThreadId,
        userMessageId: messageId,
        ordinal: 2,
      },
    ],
    nodes: [{ id: rootNodeId, checkpointScopeId }],
    attempts: [{ id: attemptId }],
    providerThreads: [{ id: providerThreadId, providerSessionId }],
    messages: [{ id: messageId, text: "Continue", attachments: [] }],
    checkpointScopes: [{ id: checkpointScopeId }],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  let projectionReadCount = 0;
  const writeIfRunCurrent = vi.fn(() =>
    Effect.succeed({ committed: true, storedEvents: [] } as never),
  );
  const startRootRun = vi.fn(() => Effect.void);
  const pruneWorktrees = vi.fn(() => Effect.void);
  const createWorktree = vi.fn(() => Effect.succeed({} as never));
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({ writeIfRunCurrent }),
        IdAllocator.layer,
        Path.layer,
        FileSystem.layerNoop({ exists: () => Effect.succeed(false) }),
        Layer.mock(GitWorkflow.GitWorkflowService)({ pruneWorktrees, createWorktree }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ workspaceRoot: "/tmp/provider-turn-start-project" } as never),
            ),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => {
            projectionReadCount += 1;
            return Effect.succeed(projection);
          },
          getTurnStartContext: () => {
            projectionReadCount += 1;
            return Effect.succeed({
              ...projection,
              hasConversation: projection.messages.some(
                (m) =>
                  m.role === "user" &&
                  (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
              ),
            });
          },
          getRuntimeRecoveryProjection: () => {
            projectionReadCount += 1;
            return Effect.fail(
              new ProjectionStore.ProjectionStoreReadError({
                threadId,
                cause: "simulated inherited-background projection failure",
              }),
            );
          },
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
        Layer.mock(ProviderAuthService.ProviderAuthService)({
          tryHandlePromptCommand: () => Effect.succeed(false),
        }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({}),
      ),
    ),
  );

  await Effect.gen(function* () {
    const error = yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2)
      .start({ threadId, runId })
      .pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(projectionReadCount).toBe(3);
    expect(pruneWorktrees).toHaveBeenCalledWith({ cwd: "/tmp/provider-turn-start-project" });
    expect(createWorktree).toHaveBeenCalledWith({
      cwd: "/tmp/provider-turn-start-project",
      refName: "feature/restore",
      path: "/tmp/missing-provider-turn-start-worktree",
    });
    expect(writeIfRunCurrent).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedStatus: "starting",
        events: expect.arrayContaining([
          expect.objectContaining({
            type: "run.updated",
            payload: expect.objectContaining({ status: "failed" }),
          }),
          // The run keeps the real cause, not a generic "Run setup failed.".
          expect.objectContaining({
            type: "turn-item.updated",
            payload: expect.objectContaining({
              type: "error",
              title: "Provider turn failed to start",
              failure: expect.objectContaining({
                code: "ProjectionStoreReadError",
                message: "simulated inherited-background projection failure",
              }),
            }),
          }),
        ]),
      }),
    );
    expect(startRootRun).not.toHaveBeenCalled();
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

function makeLocalCommandHarness(input: {
  readonly text: string;
  readonly chatControls?: ChatControls.ChatControls["Service"];
  readonly worktreePath?: string;
  readonly fileSystem?: FileSystem.FileSystem;
  readonly previousNativeSession?: boolean;
  readonly previousMessages?: ReadonlyArray<string>;
  readonly logoutFailure?: string;
  readonly openFailure?: unknown;
  /** Opens the session, then fails loading its provider thread. */
  readonly ensureThreadFailure?: unknown;
  /**
   * Resumes a thread that has a native ref: resume fails, the fresh-thread
   * fallback succeeds, then reading history for its handoff fails.
   */
  readonly historyReadFailureAfterFallback?: unknown;
  readonly interruptOpen?: boolean;
  readonly interruptRunBeforeOpenFailure?: boolean;
  readonly writeFailure?: unknown;
  /** Loads the thread and starts the run, then fails every later state read. */
  readonly failReadsAfterRunning?: boolean;
  readonly missedHistoryReadFailure?: boolean;
}) {
  const now = DateTime.makeUnsafe("2026-09-04T12:00:00Z");
  const threadId = ThreadId.make("thread-native-account-command");
  const runId = RunId.make("run-native-account-command");
  const rootNodeId = NodeId.make("root-native-account-command");
  const attemptId = RunAttemptId.make("attempt-native-account-command");
  const providerThreadId = ProviderThreadId.make("new-provider-thread");
  const providerSessionId = ProviderSessionId.make("new-provider-session");
  const oldProviderThreadId = ProviderThreadId.make("existing-native-provider-thread");
  const oldInstanceId = ProviderInstanceId.make("antigravity-personal");
  const newInstanceId = ProviderInstanceId.make("codex-personal");
  const checkpointScopeId = CheckpointScopeId.make("scope-native-account-command");
  const messageId = MessageId.make("message-native-account-command");
  const run: OrchestrationV2ThreadProjection["runs"][number] = {
    id: runId,
    threadId,
    ordinal: 2,
    providerInstanceId: newInstanceId,
    modelSelection: { instanceId: newInstanceId, model: "gpt-5.4" },
    providerThreadId,
    userMessageId: messageId,
    rootNodeId,
    activeAttemptId: attemptId,
    status: "starting",
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const providerThread: OrchestrationV2ThreadProjection["providerThreads"][number] = {
    id: providerThreadId,
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: newInstanceId,
    providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "not_loaded",
    firstRunOrdinal: 2,
    lastRunOrdinal: 2,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const message: OrchestrationV2ThreadProjection["messages"][number] = {
    id: messageId,
    threadId,
    runId,
    nodeId: rootNodeId,
    role: "user",
    text: input.text,
    attachments: [],
    streaming: false,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
  };
  let projection: OrchestrationV2ThreadProjection = {
    thread: {
      id: threadId,
      activeProviderThreadId: providerThreadId,
      projectId: ProjectId.make("project-native-account-command"),
      branch: input.worktreePath === undefined ? null : "feature/restore",
      worktreePath: input.worktreePath ?? null,
    } as OrchestrationV2ThreadProjection["thread"],
    runs: [
      ...(input.missedHistoryReadFailure
        ? [
            {
              ...run,
              id: RunId.make("missed-run"),
              ordinal: 1,
              status: "failed" as const,
              activeAttemptId: RunAttemptId.make("missed-attempt"),
            },
          ]
        : []),
      ...(input.previousNativeSession
        ? [
            {
              ...run,
              id: RunId.make("previous-native-run"),
              ordinal: 1,
              status: "completed" as const,
              providerInstanceId: oldInstanceId,
              providerThreadId: oldProviderThreadId,
            },
          ]
        : []),
      run,
    ],
    attempts: [
      {
        id: attemptId,
        runId,
        rootNodeId,
        attemptOrdinal: 1,
        providerInstanceId: newInstanceId,
        providerThreadId,
        providerTurnId: null,
        reason: "initial",
        status: "pending",
        startedAt: null,
        completedAt: null,
      },
    ],
    nodes: [
      {
        id: rootNodeId,
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status: "pending",
        countsForRun: true,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId,
        startedAt: null,
        completedAt: null,
      },
    ],
    providerThreads: [
      ...(input.previousNativeSession
        ? [
            {
              ...providerThread,
              id: oldProviderThreadId,
              providerInstanceId: oldInstanceId,
              driver: ProviderDriverKind.make("antigravity"),
              lastRunOrdinal: 1,
              nativeThreadRef: {
                driver: ProviderDriverKind.make("antigravity"),
                nativeId: "existing-session",
                strength: "strong" as const,
              },
            },
          ]
        : []),
      providerThread,
    ],
    messages: [
      ...(input.previousMessages ?? []).map((text, index) => ({
        ...message,
        id: MessageId.make(`previous-message-${index}`),
        text,
      })),
      message,
    ],
    checkpointScopes: [
      {
        id: checkpointScopeId,
        threadId,
        runId,
        nodeId: rootNodeId,
        parentScopeId: null,
        providerThreadId,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/tmp/native-account-command",
        createdAt: now,
      },
    ],
    providerSessions: [],
    providerTurns: [],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
    visibleTurnItems: [],
    runtimeRequests: [],
    subagents: [],
    plans: [],
    checkpoints: [],
    updatedAt: now,
  };
  if ("historyReadFailureAfterFallback" in input) {
    const nativeThreadRef = {
      driver: providerThread.driver,
      nativeId: "native-resume-thread",
      strength: "strong" as const,
    };
    projection = {
      ...projection,
      providerThreads: projection.providerThreads.map((candidate) =>
        candidate.id === providerThreadId ? { ...candidate, nativeThreadRef } : candidate,
      ),
    };
  }
  const events: Array<OrchestrationV2DomainEvent> = [];
  const interruptRun = () => {
    projection = {
      ...projection,
      runs: projection.runs.map((candidate) =>
        candidate.id === runId
          ? { ...candidate, status: "interrupted", completedAt: now }
          : candidate,
      ),
    };
  };
  const ensureThread = vi.fn(() =>
    Effect.sync(() => {
      if (input.interruptRunBeforeOpenFailure === true) interruptRun();
    }).pipe(
      Effect.andThen(
        Effect.fail(
          new ProviderAdapter.ProviderAdapterEventStreamError({
            driver: providerThread.driver,
            providerSessionId,
            cause: input.ensureThreadFailure,
          }),
        ),
      ),
    ),
  );
  const resumeFallbackSession = {
    driver: providerThread.driver,
    resumeThread: () =>
      Effect.fail(
        new ProviderAdapter.ProviderAdapterEventStreamError({
          driver: providerThread.driver,
          providerSessionId,
          cause: "native thread is gone",
        }),
      ),
    ensureThread: () => Effect.succeed(providerThread),
  };
  const open = vi.fn(() =>
    input.interruptOpen === true
      ? Effect.interrupt
      : "historyReadFailureAfterFallback" in input
        ? Effect.succeed(resumeFallbackSession as never)
        : "ensureThreadFailure" in input
          ? Effect.succeed({ driver: providerThread.driver, ensureThread } as never)
          : "openFailure" in input
            ? Effect.sync(() => {
                if (input.interruptRunBeforeOpenFailure === true) interruptRun();
              }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new ProviderSessionManager.ProviderSessionOpenError({
                      instanceId: newInstanceId,
                      providerSessionId,
                      cause: input.openFailure,
                    }),
                  ),
                ),
              )
            : input.failReadsAfterRunning === true || input.missedHistoryReadFailure === true
              ? Effect.succeed({
                  driver: providerThread.driver,
                  providerSession: {
                    id: providerSessionId,
                    driver: providerThread.driver,
                    providerInstanceId: newInstanceId,
                    status: "ready",
                    cwd: "/tmp/native-account-command",
                    model: null,
                    capabilities: CodexProviderCapabilitiesV2,
                    createdAt: now,
                    updatedAt: now,
                    lastError: null,
                  },
                  ensureThread: () => Effect.succeed(providerThread),
                } as never)
              : Effect.die("A local command must not open a native session."),
  );
  const startRootRun = vi.fn<
    (input: RunExecutionService.RunExecutionServiceV2StartRootRunInput) => Effect.Effect<void>
  >(() =>
    input.failReadsAfterRunning === true
      ? Effect.void
      : Effect.die("A local command must not start a native turn."),
  );
  const failReadIfRunning = Effect.suspend(() =>
    input.failReadsAfterRunning === true &&
    projection.runs.find((candidate) => candidate.id === runId)?.status === "running"
      ? Effect.fail(
          new ProjectionStore.ProjectionStoreReadError({ threadId, cause: "database unavailable" }),
        )
      : Effect.void,
  );
  const tryHandlePromptCommand = vi.fn(() =>
    input.logoutFailure === undefined
      ? Effect.succeed(true)
      : Effect.fail(
          new ProviderSetupError({
            instanceId: oldInstanceId,
            operation: "logout",
            detail: input.logoutFailure,
          }),
        ),
  );
  const writeIfRunCurrent = vi.fn(({ events: incoming, activeAttemptId, expectedStatus }) =>
    "writeFailure" in input
      ? Effect.fail(
          new EventSink.EventSinkWriteError({
            eventCount: incoming.length,
            cause: input.writeFailure,
          }),
        )
      : Effect.sync(() => {
          const current = projection.runs.find((candidate) => candidate.id === runId);
          const committed =
            current !== undefined &&
            current.activeAttemptId === activeAttemptId &&
            current.status === expectedStatus;
          if (committed) {
            for (const event of incoming) {
              expect(isDomainEvent(event)).toBe(true);
              events.push(event);
              projection = ProjectionStore.applyToProjection(projection, event);
            }
          }
          return { committed, storedEvents: [] };
        }),
  );
  const resolveRuntimePolicy = vi.fn(
    ({ thread }: Parameters<RuntimePolicy.RuntimePolicyV2Shape["resolve"]>[0]) =>
      Effect.succeed({ cwd: thread.worktreePath ?? "/tmp/native-account-command" } as never),
  );
  const createWorktree = vi.fn(() => Effect.succeed({} as never));
  const getThreadRecords = vi.fn<ProjectionStore.ProjectionStoreV2Shape["getThreadRecords"]>(
    (_threadId, _fields, filter) =>
      filter?.turnItemRunIds !== undefined && "historyReadFailureAfterFallback" in input
        ? Effect.fail(
            new ProjectionStore.ProjectionStoreReadError({
              threadId,
              cause: input.historyReadFailureAfterFallback,
            }),
          )
        : Effect.succeed(projection),
  );
  const getTurnStartContext = vi.fn(() =>
    Effect.succeed({
      ...projection,
      hasConversation: projection.messages.some(
        (m) =>
          m.role === "user" &&
          (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
      ),
    }),
  );
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({
          prepareProviderHandoff: () => Effect.die("history read must fail first"),
        }),
        Layer.mock(EventSink.EventSinkV2)({ writeIfRunCurrent }),
        IdAllocator.layer,
        Path.layer,
        input.fileSystem === undefined
          ? FileSystem.layerNoop({ exists: () => Effect.succeed(true) })
          : Layer.succeed(FileSystem.FileSystem, input.fileSystem),
        Layer.mock(GitWorkflow.GitWorkflowService)({
          pruneWorktrees: () => Effect.void,
          createWorktree,
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(Option.some({ workspaceRoot: "/tmp/native-account-project" } as never)),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords,
          getTurnStartContext,
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          getRunAttemptState: (_threadId, runId) =>
            failReadIfRunning.pipe(
              Effect.map(() => projection.runs.find((run) => run.id === runId)),
            ),
          getTurnStartHistory: () =>
            Effect.fail(
              new ProjectionStore.ProjectionStoreReadError({
                threadId,
                cause: input.historyReadFailureAfterFallback,
              }),
            ),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open }),
        Layer.mock(ProviderAuthService.ProviderAuthService)({ tryHandlePromptCommand }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: resolveRuntimePolicy,
        }),
        Layer.succeed(ChatControls.ChatControls, input.chatControls ?? ChatControls.make().store),
      ),
    ),
  );
  return {
    getThreadRecords,
    getTurnStartContext,
    setProjection: (next: OrchestrationV2ThreadProjection) => {
      projection = next;
    },
    resolveRuntimePolicy,
    createWorktree,
    open,
    writeIfRunCurrent,
    startRootRun,
    tryHandlePromptCommand,
    events,
    oldInstanceId,
    newInstanceId,
    attemptId,
    projection: () => projection,
    start: Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({ threadId, runId });
    }).pipe(Effect.provide(layer)),
    startWithRetry: Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({
        threadId,
        runId,
        willRetry: true,
      });
    }).pipe(Effect.provide(layer)),
  };
}

effectIt.effect.each(["cleanup-first", "startup-first"])(
  "coordinates provider startup with %s",
  (order) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-start-" });
      const worktreePath = path.join(workspaceRoot, "worktree");
      yield* fileSystem.makeDirectory(worktreePath);
      const release = yield* Deferred.make<void>();
      const openEntered = yield* Deferred.make<void>();
      const harness = makeLocalCommandHarness({
        text: "Continue",
        worktreePath,
        fileSystem,
        failReadsAfterRunning: true,
      });
      harness.createWorktree.mockImplementation(() =>
        fileSystem.makeDirectory(worktreePath).pipe(Effect.as({} as never), Effect.orDie),
      );
      const open = harness.open.getMockImplementation()!;
      harness.open.mockImplementation(() =>
        Effect.gen(function* () {
          expect(yield* fileSystem.exists(worktreePath).pipe(Effect.orDie)).toBe(true);
          yield* Deferred.succeed(openEntered, undefined);
          if (order === "startup-first") yield* Deferred.await(release);
          return yield* open();
        }),
      );
      let cleanupEntered = false;
      const cleanupEffect = withWorkspaceLease(
        worktreePath,
        Effect.gen(function* () {
          cleanupEntered = true;
          if (order === "cleanup-first") yield* Deferred.await(release);
          else {
            expect(harness.projection().providerSessions).toHaveLength(1);
            expect(harness.projection().runs.at(-1)?.status).toBe("running");
          }
          yield* fileSystem.remove(worktreePath, { recursive: true, force: true });
        }),
      );
      const cleanup =
        order === "cleanup-first"
          ? yield* cleanupEffect.pipe(Effect.forkChild({ startImmediately: true }))
          : undefined;
      const startup = yield* harness.start.pipe(Effect.forkChild({ startImmediately: true }));
      if (order === "cleanup-first") expect(harness.open).not.toHaveBeenCalled();
      if (order === "startup-first") yield* Deferred.await(openEntered);
      const laterCleanup =
        order === "startup-first"
          ? yield* cleanupEffect.pipe(Effect.forkChild({ startImmediately: true }))
          : undefined;
      if (order === "startup-first") expect(cleanupEntered).toBe(false);
      yield* Deferred.succeed(release, undefined);
      if (cleanup !== undefined) yield* Fiber.join(cleanup);
      yield* Fiber.join(startup);
      if (laterCleanup !== undefined) yield* Fiber.join(laterCleanup);
      if (order === "cleanup-first") {
        expect(harness.createWorktree).toHaveBeenCalledWith({
          cwd: "/tmp/native-account-project",
          refName: "feature/restore",
          path: worktreePath,
        });
      }
      expect(harness.resolveRuntimePolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          thread: expect.objectContaining({ worktreePath }),
        }),
      );
      expect(harness.open).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimePolicy: expect.objectContaining({ cwd: worktreePath }),
        }),
      );
      expect(harness.startRootRun).toHaveBeenCalledWith(
        expect.objectContaining({
          appThread: expect.objectContaining({ worktreePath }),
          runtimePolicy: expect.objectContaining({ cwd: worktreePath }),
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

effectIt.effect("opens a prepared run's first turn with its project setup notice", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Implement the task",
      worktreePath: "/tmp/provider-start-setup-notice",
      failReadsAfterRunning: true,
    });
    const projection = harness.projection();
    const run = projection.runs[0]!;
    const notice =
      "Project setup failed (exit 1: ERR_PNPM_FETCH_404); dependencies may be missing.";
    harness.setProjection({
      ...projection,
      turnItems: [
        {
          id: TurnItemId.make("turn-item-workspace-preparation"),
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: run.rootNodeId!,
          providerThreadId: run.providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: "Workspace ready",
          startedAt: DateTime.makeUnsafe("2026-09-04T12:00:00Z"),
          completedAt: DateTime.makeUnsafe("2026-09-04T12:00:00Z"),
          updatedAt: DateTime.makeUnsafe("2026-09-04T12:00:00Z"),
          type: "command_execution",
          input: WORKSPACE_PREPARATION_INPUT,
          output: notice,
          outputIndicatesFailure: true,
          exitCode: 0,
        },
      ],
    });
    yield* harness.start;
    expect(harness.startRootRun).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ text: `${notice}\n\nImplement the task` }),
      }),
    );
  }),
);

effectIt.effect("reads only thread state before taking the startup lease", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "/logout", previousNativeSession: true });
    yield* harness.start;
    expect(harness.getThreadRecords).toHaveBeenCalledExactlyOnceWith(
      harness.projection().thread.id,
      [],
    );
    expect(harness.getTurnStartContext).toHaveBeenCalledOnce();
    expect(harness.projection().runs.at(-1)?.status).toBe("completed");
  }),
);

effectIt.effect("reads current startup state after waiting for the workspace lease", () =>
  Effect.gen(function* () {
    const worktreePath = "/tmp/provider-start-fresh-state";
    const release = yield* Deferred.make<void>();
    const readEntered = yield* Deferred.make<void>();
    const harness = makeLocalCommandHarness({
      text: "Continue",
      worktreePath,
      failReadsAfterRunning: true,
    });
    harness.getThreadRecords.mockImplementationOnce(() =>
      Deferred.succeed(readEntered, undefined).pipe(Effect.as(harness.projection())),
    );
    const holder = yield* withWorkspaceLease(worktreePath, Deferred.await(release)).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    const startup = yield* harness.start.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(readEntered);
    expect(harness.getTurnStartContext).not.toHaveBeenCalled();
    const projection = harness.projection();
    harness.setProjection({
      ...projection,
      runs: projection.runs.map((run) => ({ ...run, status: "running" })),
    });
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
    yield* Fiber.join(startup);
    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
  }),
);

effectIt.effect.each([
  { boundary: "policy resolution", nativeMode: "ensure", loss: "replaced" },
  { boundary: "policy resolution", nativeMode: "ensure", loss: "interrupted" },
  { boundary: "session opening", nativeMode: "ensure", loss: "replaced" },
  { boundary: "session opening", nativeMode: "ensure", loss: "interrupted" },
  { boundary: "session opening", nativeMode: "resume", loss: "replaced" },
  { boundary: "session opening", nativeMode: "fork", loss: "replaced" },
])(
  "does not continue $nativeMode startup when $loss during $boundary",
  ({ boundary, nativeMode, loss }) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const gate = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const harness = makeLocalCommandHarness({ text: "Continue" });
      const projection = harness.projection();
      const run = projection.runs[0]!;
      const providerThread = projection.providerThreads[0]!;
      if (nativeMode === "resume") {
        harness.setProjection({
          ...projection,
          providerThreads: [
            {
              ...providerThread,
              nativeThreadRef: {
                driver: providerThread.driver,
                nativeId: "existing",
                strength: "strong",
              },
            },
          ],
        });
      } else if (nativeMode === "fork") {
        const sourceThreadId = ThreadId.make("fork-source");
        harness.getThreadRecords.mockReturnValue(
          Effect.succeed({
            ...projection,
            thread: { ...projection.thread, id: sourceThreadId },
          }),
        );
        harness.setProjection({
          ...projection,
          contextTransfers: [
            {
              id: ContextTransferId.make("pending-fork"),
              type: "fork",
              sourceThreadId,
              targetThreadId: projection.thread.id,
              sourcePoint: { threadId: sourceThreadId, runId: run.id },
              basePoint: null,
              sourceProviderInstanceId: run.providerInstanceId,
              targetProviderInstanceId: run.providerInstanceId,
              targetRunId: run.id,
              status: "pending",
              resolution: null,
              createdBy: "user",
              error: null,
              createdAt: projection.updatedAt,
              updatedAt: projection.updatedAt,
              consumedAt: null,
            },
          ],
        });
      }
      const ensureThread = vi.fn(() => Effect.succeed(providerThread));
      const resumeThread = vi.fn(() => Effect.succeed(providerThread));
      const forkThread = vi.fn(() => Effect.succeed(providerThread));
      harness.open.mockReturnValue(
        (boundary === "session opening" ? gate : Effect.void).pipe(
          Effect.as({
            driver: providerThread.driver,
            ensureThread,
            resumeThread,
            forkThread,
          } as never),
        ),
      );
      if (boundary === "policy resolution") {
        harness.resolveRuntimePolicy.mockReturnValue(
          gate.pipe(Effect.as({ cwd: "/tmp/native-account-command" } as never)),
        );
      }

      const startup = yield* harness.start.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      const current = harness.projection();
      const replacementId = RunAttemptId.make("replacement-attempt");
      const updated = {
        ...current,
        runs: current.runs.map((candidate) =>
          loss === "replaced"
            ? { ...candidate, activeAttemptId: replacementId }
            : { ...candidate, status: "interrupted" as const, completedAt: current.updatedAt },
        ),
        attempts:
          loss === "replaced"
            ? [
                ...current.attempts,
                { ...current.attempts[0]!, id: replacementId, attemptOrdinal: 2 },
              ]
            : current.attempts,
      };
      harness.setProjection(updated);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(startup);

      expect(harness.open).toHaveBeenCalledTimes(boundary === "session opening" ? 1 : 0);
      expect(ensureThread).not.toHaveBeenCalled();
      expect(resumeThread).not.toHaveBeenCalled();
      expect(forkThread).not.toHaveBeenCalled();
      expect(harness.startRootRun).not.toHaveBeenCalled();
      expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
      expect(harness.events).toEqual([]);
      expect(harness.projection()).toEqual(updated);
    }),
);

effectIt.effect("starts another provider in the same checkout while a turn is pending", () =>
  Effect.gen(function* () {
    const worktreePath = "/tmp/provider-start-shared-checkout";
    const turnEntered = yield* Deferred.make<void>();
    const releaseTurn = yield* Deferred.make<void>();
    const first = makeLocalCommandHarness({
      text: "Continue",
      worktreePath,
      failReadsAfterRunning: true,
    });
    const second = makeLocalCommandHarness({
      text: "Continue",
      worktreePath,
      failReadsAfterRunning: true,
    });
    first.startRootRun.mockImplementation(() =>
      Deferred.succeed(turnEntered, undefined).pipe(Effect.andThen(Deferred.await(releaseTurn))),
    );
    const pending = yield* first.start.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(turnEntered);
    yield* second.start;
    expect(second.startRootRun).toHaveBeenCalledOnce();
    expect(second.projection().runs.at(-1)?.status).toBe("running");
    yield* Deferred.succeed(releaseTurn, undefined);
    yield* Fiber.join(pending);
  }),
);

effectIt.effect("terminalizes a starting run when its provider session cannot open", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("DESCRIPTION is not valid ACP JSON"),
    });

    yield* harness.start;

    expect(harness.open).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.writeIfRunCurrent).toHaveBeenCalledWith(
      expect.objectContaining({
        activeAttemptId: harness.attemptId,
        expectedStatus: "starting",
      }),
    );
    const projection = harness.projection();
    expect(projection.runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.attempts[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.nodes[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.turnItems).toMatchObject([
      {
        type: "error",
        status: "failed",
        failure: {
          class: "provider_error",
          message: "DESCRIPTION is not valid ACP JSON",
        },
      },
    ]);
  }),
);

effectIt.effect("preserves an actionable ACP model rejection through session startup", () =>
  Effect.gen(function* () {
    const message =
      'The agent did not accept the model "named". Choose another model for this provider, then retry.';
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new ProviderAdapter.ProviderAdapterOpenSessionError({
        driver: ProviderDriverKind.make("acpRegistry"),
        providerSessionId: ProviderSessionId.make("rejected-model"),
        cause: Object.assign(new Error(message), { _tag: "AcpModelSelectionError" }),
      }),
    });
    yield* harness.start;
    expect(harness.projection().turnItems).toMatchObject([{ type: "error", failure: { message } }]);
  }),
);

effectIt.effect("leaves the run starting when a session-open failure will be retried", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
    });

    const error = yield* harness.startWithRetry.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
  }),
);

effectIt.effect("keeps a session-open failure retryable when terminal persistence fails", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
      writeFailure: new Error("database unavailable"),
    });

    const error = yield* harness.start.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.writeIfRunCurrent).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect("fails the run without a retry when the provider needs sign-in", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new ProviderAdapter.ProviderAdapterOpenSessionError({
        driver: ProviderDriverKind.make("antigravity"),
        providerSessionId: ProviderSessionId.make("new-provider-session"),
        requiresSignIn: true,
      }),
    });

    yield* harness.startWithRetry;

    expect(harness.open).toHaveBeenCalledOnce();
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    expect(harness.projection().turnItems).toMatchObject([
      {
        type: "error",
        status: "failed",
        failure: {
          class: "provider_error",
          message: "Failed to open antigravity provider session new-provider-session.",
        },
      },
    ]);
  }),
);

effectIt.effect("does not terminalize a provider-session open interruption", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue", interruptOpen: true });

    const exit = yield* Effect.exit(harness.start);

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect("does not overwrite a run interrupted while its provider session opens", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
      interruptRunBeforeOpenFailure: true,
    });

    yield* harness.start;

    expect(harness.writeIfRunCurrent).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    const projection = harness.projection();
    expect(projection.runs.at(-1)?.status).toBe("interrupted");
    expect(projection.attempts[0]?.status).toBe("pending");
    expect(projection.nodes[0]?.status).toBe("pending");
    expect(projection.turnItems).toEqual([]);
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect("preserves the native Codex thread-store error on thread creation", () =>
  Effect.gen(function* () {
    const message =
      "error creating thread: Fatal error: Failed to initialize session: thread-store internal error: failed to open";
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: CodexAppServerRequestError.fromProtocolError(
        { code: -32603, message },
        "thread/start",
        "2",
      ),
    });
    yield* harness.start;
    expect(harness.projection().turnItems).toMatchObject([
      { failure: { class: "provider_error", message } },
    ]);
    expect(harness.startRootRun).not.toHaveBeenCalled();
  }),
);

effectIt.effect("fails a starting run when its last start attempt cannot load the thread", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("Pi RPC read failed: pi process exited with code 1."),
    });

    yield* harness.start;

    expect(harness.startRootRun).not.toHaveBeenCalled();
    const projection = harness.projection();
    expect(projection.runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.attempts[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.nodes[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.turnItems).toMatchObject([
      {
        type: "error",
        title: "Provider turn failed to start",
        failure: {
          class: "provider_error",
          message: "Pi RPC read failed: pi process exited with code 1.",
        },
      },
    ]);
  }),
);

effectIt.effect.each(["openFailure", "ensureThreadFailure"] as const)(
  "settles a provider quota at %s even when the outbox has retries left",
  (stage) =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "Continue",
        [stage]: new Error("HTTP 429: Resource exhausted."),
      });
      yield* harness.startWithRetry;
      expect(harness.projection().runs.at(-1)?.status).toBe("failed");
      expect(harness.projection().turnItems).toMatchObject([
        { failure: { class: "usage_limit", retryable: false } },
      ]);
      expect(harness.startRootRun).not.toHaveBeenCalled();
    }),
);

effectIt.effect("preserves the quota inside an ACP session setup refusal", () =>
  Effect.gen(function* () {
    const details = "Token quota is exhausted. It will reset at 2026-12-01 00:00 UTC.";
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new AcpRequestError({
        code: -32603,
        errorMessage: "Internal error",
        data: { details },
      }),
    });
    yield* harness.startWithRetry;
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    expect(harness.projection().turnItems).toMatchObject([
      {
        failure: {
          class: "usage_limit",
          message: details,
          retryable: false,
          resetAt: "2026-12-01T00:00:00.000Z",
        },
      },
    ]);
  }),
);

effectIt.effect("settles the run even if decoding its optional reset time throws", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new AcpRequestError({
        code: 429,
        errorMessage: "Usage limit reached. Resets at 2026-12-01T00:00Z.",
      }),
    });
    const parse = Date.parse;
    const clock = vi.spyOn(Date, "parse").mockImplementation((value) => {
      if (value === "2026-12-01T00:00Z") throw new RangeError("Invalid date");
      return parse(value);
    });
    try {
      yield* harness.startWithRetry;
      expect(clock).toHaveBeenCalledWith("2026-12-01T00:00Z");
      expect(harness.projection().runs.at(-1)?.status).toBe("failed");
      expect(harness.projection().turnItems).toMatchObject([{ failure: { class: "usage_limit" } }]);
      expect(harness.projection().turnItems[0]).not.toHaveProperty("failure.resetAt");
    } finally {
      clock.mockRestore();
    }
  }),
);

effectIt.effect("leaves the run starting when a thread-load failure will be retried", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("pi process exited with code 1"),
    });

    const error = yield* harness.startWithRetry.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
  }),
);

effectIt.effect("keeps a thread-load failure retryable when terminal persistence fails", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("pi process exited with code 1"),
      writeFailure: new Error("database unavailable"),
    });

    const error = yield* harness.start.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect(
  "settles a store failure after the provider loaded the thread on the last attempt",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "Continue",
        historyReadFailureAfterFallback: new Error("database unavailable"),
      });

      const error = yield* harness.start.pipe(Effect.flip);

      expect(error._tag).toBe("ProviderTurnStartError");
      expect((error.cause as { _tag?: string } | undefined)?._tag).toBe("ProjectionStoreReadError");
      expect(harness.writeIfRunCurrent).toHaveBeenCalledOnce();
      expect(harness.projection().runs.at(-1)?.status).toBe("failed");
      expect(harness.startRootRun).not.toHaveBeenCalled();
    }),
);

effectIt.effect(
  "does not replay an automatic retry into a fresh transcript when native resume fails",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "Continue",
        historyReadFailureAfterFallback: new Error("must not read fallback history"),
      });
      const before = harness.projection();
      harness.setProjection({
        ...before,
        runs: before.runs.map((run) => ({
          ...run,
          providerRetryContinuationOfRunId: RunId.make("previous-capacity-failure"),
          automaticProviderRetry: { attempt: 1, status: "started", scheduledAt: null },
        })),
      });
      yield* harness.start;
      const after = harness.projection();
      expect(after.runs.at(-1)?.status).toBe("failed");
      expect(after.providerThreads[0]?.nativeThreadRef?.nativeId).toBe("native-resume-thread");
      expect(after.contextTransfers).toEqual([]);
      expect(harness.startRootRun).not.toHaveBeenCalled();
    }),
);

effectIt.effect("reads missed history before marking the run running", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue", missedHistoryReadFailure: true });
    yield* harness.startWithRetry.pipe(Effect.flip);
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    yield* harness.start.pipe(Effect.flip);
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    expect(harness.startRootRun).not.toHaveBeenCalled();
  }),
);

effectIt.effect(
  "records retry preparation before app-side running reaches provider execution",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({ text: "Continue", failReadsAfterRunning: true });
      const projection = harness.projection();
      harness.setProjection({
        ...projection,
        runs: projection.runs.map((run) => ({
          ...run,
          providerRetryContinuationOfRunId: RunId.make("previous-capacity-failure"),
          automaticProviderRetry: { attempt: 1, status: "started", scheduledAt: null },
        })),
      });
      yield* harness.start;
      const after = harness.projection();
      expect(after.runs.at(-1)?.status).toBe("running");
      expect(after.attempts[0]?.providerStartRequested).toBe(false);
      expect(harness.startRootRun.mock.calls[0]?.[0].attempt.providerStartRequested).toBe(false);
      expect(after.providerTurns).toEqual([]);
    }),
);

effectIt.effect("does not mistake a failed state read for a superseded run", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue", failReadsAfterRunning: true });

    yield* harness.start;

    expect(harness.projection().runs.at(-1)?.status).toBe("running");
    const controls = harness.startRootRun.mock.calls[0]?.[0];
    expect(controls).toBeDefined();
    if (controls === undefined) return;
    // "false" would skip the provider turn or the terminal write and leave the
    // run active. A read failure must reach the caller instead.
    const startCheck = yield* Effect.flip(controls.shouldStartProviderTurn!());
    const finalizeCheck = yield* Effect.flip(controls.shouldFinalizeRun!());
    expect(startCheck._tag).toBe("ProjectionStoreReadError");
    expect(finalizeCheck._tag).toBe("ProjectionStoreReadError");
  }),
);

effectIt.effect("does not overwrite a run interrupted while its thread loads", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("pi process exited with code 1"),
      interruptRunBeforeOpenFailure: true,
    });

    yield* harness.start;

    expect(harness.projection().runs.at(-1)?.status).toBe("interrupted");
    expect(harness.projection().turnItems).toEqual([]);
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect(
  "signs out the existing native provider before opening the newly selected provider",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({ text: "/logout", previousNativeSession: true });

      yield* harness.start;
      yield* harness.start;

      expect(harness.tryHandlePromptCommand).toHaveBeenCalledExactlyOnceWith({
        instanceId: harness.oldInstanceId,
        text: "/logout",
        hasAttachments: false,
      });
      expect(harness.open).not.toHaveBeenCalled();
      expect(harness.startRootRun).not.toHaveBeenCalled();
      const projection = harness.projection();
      expect(projection.runs.at(-1)?.status).toBe("completed");
      expect(projection.attempts[0]?.status).toBe("completed");
      expect(projection.nodes[0]?.status).toBe("completed");
      expect(projection.turnItems).toMatchObject([
        {
          type: "command_execution",
          title: "Provider signed out",
          output: "Provider signed out",
          status: "completed",
        },
      ]);
      expect(projection.providerTurns).toEqual([]);
      expect(projection.checkpoints).toEqual([]);
    }),
);

effectIt.effect("persists a failed sign-out without starting a provider turn", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "/logout",
      logoutFailure: "Could not stop all sessions for this provider. Try again.",
    });

    yield* harness.start;

    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    expect(harness.projection().turnItems).toMatchObject([
      {
        type: "error",
        title: "Provider sign-out failed",
        failure: {
          class: "permission_error",
          message: "Could not stop all sessions for this provider. Try again.",
        },
      },
    ]);
  }),
);

for (const previousMessages of [[], ["/compact", " /COMPACT "]]) {
  effectIt.effect(
    `rejects compaction without conversation context after ${previousMessages.length} prior compactions`,
    () =>
      Effect.gen(function* () {
        const harness = makeLocalCommandHarness({ text: "/compact", previousMessages });

        yield* harness.start;

        expect(harness.open).not.toHaveBeenCalled();
        expect(harness.tryHandlePromptCommand).not.toHaveBeenCalled();
        expect(harness.startRootRun).not.toHaveBeenCalled();
        expect(harness.projection().runs.at(-1)?.status).toBe("failed");
        expect(harness.projection().turnItems).toMatchObject([
          {
            type: "error",
            failure: {
              class: "validation_error",
              message: "Start a conversation before compacting this thread.",
            },
          },
        ]);
      }),
  );
}

effectIt.effect.each(["handing-off", "in-terminal"] as const)(
  "refuses provider startup while the chat is %s",
  (phase) => {
    const threadId = ThreadId.make(`terminal-start-${phase}`);
    const projection = {
      thread: { id: threadId, worktreePath: null },
    } as unknown as OrchestrationV2ThreadProjection;
    const dependencies = Layer.mergeAll(
      TerminalHandoffState.layer,
      Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
      Layer.mock(EventSink.EventSinkV2)({}),
      IdAllocator.layer,
      Layer.mock(GitWorkflow.GitWorkflowService)({}),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(ProviderAuthService.ProviderAuthService)({}),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadRecords: () => Effect.succeed(projection),
      }),
      Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
        open: () => Effect.die("must not open a provider"),
      }),
      Layer.mock(RunExecutionService.RunExecutionServiceV2)({
        startRootRun: () => Effect.die("must not start a turn"),
      }),
      Layer.mock(RuntimePolicy.RuntimePolicyV2)({}),
    );
    const layer = ProviderTurnStart.layer.pipe(
      Layer.provideMerge(dependencies),
      Layer.provide(NodeServices.layer),
    );
    return Effect.gen(function* () {
      const state = yield* TerminalHandoffState.TerminalHandoffState;
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const handoff = yield* state
        .handoff(
          threadId,
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      if (phase === "in-terminal") {
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(handoff);
      }
      const error = yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2)
        .start({ threadId, runId: RunId.make("run-terminal") })
        .pipe(Effect.flip);
      expect(error.message).toBe(
        phase === "in-terminal"
          ? "This chat is open in Terminal. Bring it back to send here."
          : "This chat is being handed to Terminal. Try again in a moment.",
      );
      if (phase === "handing-off") {
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(handoff);
      }
    }).pipe(Effect.provide(layer));
  },
);

effectIt.effect("includes a refused wake's child result with the next provider input", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue the review",
      failReadsAfterRunning: true,
    });
    const projection = harness.projection();
    const run = projection.runs.at(-1)!;
    const id = NodeId.make("carried-result");
    harness.setProjection({
      ...projection,
      subagents: [
        {
          id,
          threadId: run.threadId,
          runId: run.id,
          parentNodeId: run.rootNodeId!,
          origin: "app_owned",
          createdBy: "agent",
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: run.providerInstanceId,
          providerThreadId: null,
          childThreadId: null,
          nativeTaskRef: null,
          prompt: "Read the source",
          title: null,
          model: null,
          status: "failed",
          result: "Recovered findings",
          startedAt: null,
          completedAt: run.requestedAt,
          updatedAt: run.requestedAt,
          completionDelivery: { state: "pending", observedByRunId: null, withNextTurn: true },
        },
      ],
    });
    yield* harness.start;
    const input = harness.startRootRun.mock.calls[0]?.[0];
    expect(input?.message.text).toContain("Recovered findings\n\nContinue the review");
    expect(input?.run.carriedTaskIds).toEqual([id]);
    expect(harness.projection().messages.at(-1)?.text).toBe("Continue the review");
  }),
);

effectIt.effect("projects the debug workflow only for the provider turn", () =>
  Effect.gen(function* () {
    const debug = expandDebugCommand("/debug stale phone");
    const harness = makeLocalCommandHarness({ text: debug.text, failReadsAfterRunning: true });
    const projection = harness.projection();
    harness.setProjection({
      ...projection,
      messages: projection.messages.map((message) => ({ ...message, context: debug.context! })),
    });
    yield* harness.start;
    const text = harness.startRootRun.mock.calls[0]?.[0].message.text;
    expect(text).toContain("stale phone");
    expect(text?.match(/Debug workflow:/g)).toHaveLength(1);
    expect(text).toContain("Reproduce it now, then pick Done");
    expect(harness.projection().messages[0]?.text).toBe(debug.text);
    expect(JSON.stringify(harness.projection().messages[0])).not.toContain("hypotheses");
  }),
);

effectIt.effect("sends one back-on notice after turning subagents off and on", () =>
  Effect.gen(function* () {
    const chatControls = ChatControls.make().store;
    const harness = makeLocalCommandHarness({
      text: "Continue.",
      failReadsAfterRunning: true,
      chatControls,
    });
    const projection = harness.projection();
    harness.setProjection({
      ...projection,
      thread: { ...projection.thread, activeProviderThreadId: projection.providerThreads[0]!.id },
    });
    const threadId = projection.thread.id;
    yield* chatControls.command({ action: "subagents", threadId, enabled: false });
    expect(chatControls.consumeSubagentNotice(threadId, true)).toBe(true);
    yield* chatControls.command({ action: "subagents", threadId, enabled: true });
    yield* harness.start;
    expect(harness.startRootRun.mock.calls[0]?.[0].message.text).toBe(
      "Subagents are back on for this chat.\nContinue.",
    );
    expect(chatControls.consumeSubagentNotice(threadId, true)).toBe(false);
  }),
);
