import * as ScheduledTaskStateTest from "../scheduledTasks/ScheduledTaskState.testkit.ts";
import { expandDebugCommand } from "@t3tools/shared/debugCommand";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as ServerConfig from "../config.ts";
import { createPendingAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import * as ThreadMessageIntake from "./ThreadMessageIntake.ts";
import { assert, it, vi } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  ChatAttachmentId,
  ComposerContextId,
  type ChatAttachment,
  CommandId,
  EventId,
  EnvironmentId,
  DEFAULT_SERVER_SETTINGS,
  GitCommandError,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  ProviderSessionId,
  OrchestrationV2ThreadProjectionJson,
  ScheduledTaskId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadTitleRegeneration from "./ThreadTitleRegenerationService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { workspaceSetupNotice } from "./workspacePreparation.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const projectId = ProjectId.make("project:launch-test");
const otherProjectId = ProjectId.make("project:launch-other");
const encodeThreadProjection = Schema.encodeEffect(OrchestrationV2ThreadProjectionJson);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;
const project = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: modelSelection,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  deletedAt: null,
} as const;

const otherProject = {
  ...project,
  id: otherProjectId,
  title: "Other",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in launch tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

interface HarnessOptions {
  readonly closeTerminal?: TerminalManager.TerminalManager["Service"]["close"];
  readonly adapters?: ReadonlyArray<ProviderAdapter.ProviderAdapterV2["Service"]>;
  readonly managedFolders?: Layer.Layer<ManagedProjectFolders.ManagedProjectFolders>;
  readonly createWorktree?: GitWorkflow.GitWorkflowService["Service"]["createWorktree"];
  readonly fetchRemote?: GitWorkflow.GitWorkflowService["Service"]["fetchRemote"];
  readonly hasCommit?: GitWorkflow.GitWorkflowService["Service"]["hasCommit"];
  readonly renameBranch?: GitWorkflow.GitWorkflowService["Service"]["renameBranch"];
  readonly runSetup?: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"];
  readonly generateTitle?: TextGeneration.TextGeneration["Service"]["generateThreadTitle"];
  readonly generateBranchName?: TextGeneration.TextGeneration["Service"]["generateBranchName"];
  readonly serverSettings?: Parameters<typeof ServerSettings.layerTest>[0];
  readonly afterPolicyRead?: Effect.Effect<void>;
  readonly projectAvailable?: () => boolean;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly readQuota?: Parameters<typeof ProviderRegistryMock.layer>[1];
  readonly git?: Partial<GitWorkflow.GitWorkflowService["Service"]>;
}

function makeHarness(options: HarnessOptions = {}) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerRegistry = ProviderAdapterRegistry.layerFromAdapters(options.adapters ?? [adapter]);
  const settingsBase = ServerSettings.layerTest(options.serverSettings);
  const afterPolicyRead = options.afterPolicyRead;
  const layerServerSettings = afterPolicyRead
    ? Layer.effect(
        ServerSettings.ServerSettingsService,
        Effect.gen(function* () {
          const settings = yield* ServerSettings.ServerSettingsService;
          return {
            ...settings,
            getProviderPolicy: settings.getProviderPolicy.pipe(Effect.tap(() => afterPolicyRead)),
          };
        }),
      ).pipe(Layer.provide(settingsBase))
    : settingsBase;
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "thread-launch" },
    layerRegistry,
    {
      databaseLayer: layerDatabase,
      runEffectWorker: false,
      serverSettingsLayer: Layer.orDie(layerServerSettings),
    },
  );
  const layerReceipts = CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase));
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(layerReceipts),
  );
  const layerOutbox = EffectOutbox.layer.pipe(Layer.provide(layerDatabase));
  const createWorktree = vi.fn(
    options.createWorktree ??
      ((input) =>
        Effect.succeed({
          worktree: { path: "/repo-worktrees/feature", refName: input.newRefName, headSha: "abc" },
        } as never)),
  );
  const renameBranch = vi.fn(
    options.renameBranch ?? ((input) => Effect.succeed({ branch: input.newBranch })),
  );
  const removeWorktree = vi.fn(
    (_input: Parameters<GitWorkflow.GitWorkflowService["Service"]["removeWorktree"]>[0]) =>
      Effect.void,
  );
  const runSetup = vi.fn(
    options.runSetup ?? (() => Effect.succeed({ status: "no-script" as const })),
  );
  const closeTerminal = vi.fn(options.closeTerminal ?? (() => Effect.void));
  const generateBranchName = vi.fn(
    options.generateBranchName ?? (() => Effect.succeed({ branch: "generated-branch" })),
  );
  const generateThreadTitle = vi.fn(
    options.generateTitle ?? (() => Effect.succeed({ title: "Generated title" })),
  );
  const layerExternalServices = Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({ close: closeTerminal }),
    Layer.succeed(ProjectService.ProjectService, {
      create: () => Effect.die("unused"),
      bootstrap: () => Effect.die("unused"),
      update: () => Effect.die("unused"),
      delete: () => Effect.die("unused"),
      getById: (id) =>
        Effect.succeed(
          id === projectId && options.projectAvailable?.() !== false
            ? Option.some(project)
            : id === otherProjectId
              ? Option.some(otherProject)
              : Option.none(),
        ),
      getByWorkspaceRoot: () => Effect.succeed(Option.some(project)),
      snapshot: Effect.die("unused"),
      getShell: () => Effect.die("unused"),
      listShells: () => Effect.die("unused"),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      createWorktree,
      renameBranch,
      fetchRemote: options.fetchRemote ?? (() => Effect.void),
      hasCommit: options.hasCommit ?? (() => Effect.succeed(false)),
      remoteExists: () => Effect.succeed(true),
      remoteBranchExists: () => Effect.succeed(true),
      removeWorktree,
      resolveRemoteTrackingCommit: () =>
        Effect.succeed({ commitSha: "remote-main-sha", remoteRefName: "origin/main" }),
      ...options.git,
    }),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: runSetup,
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateThreadTitle,
      generateBranchName,
    }),
    layerServerSettings,
    ProviderRegistryMock.layer(options.providers, options.readQuota),
    options.managedFolders ??
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        folderForThread: () => Effect.succeed(Option.none()),
      }),
  );
  const layerLaunch = ThreadLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerExternalServices,
        layerThreadManagement,
        layerReceipts,
        IdAllocator.layer,
      ),
    ),
  );
  const layerProjectedProjects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: (requestedProjectId) =>
      Effect.succeed(
        requestedProjectId === projectId
          ? Option.some({
              projectId,
              title: project.title,
              workspaceRoot: project.workspaceRoot,
              defaultModelSelection: project.defaultModelSelection,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: project.scripts,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
              deletedAt: project.deletedAt,
            })
          : Option.none(),
      ),
  });
  const layerTitleRegeneration = ThreadTitleRegeneration.layer.pipe(
    Layer.provide(
      Layer.mergeAll(layerThreadManagement, layerProjectedProjects, layerExternalServices),
    ),
  );
  return {
    layer: Layer.mergeAll(
      layerOrchestrator,
      layerLaunch,
      layerRegistry,
      layerThreadManagement,
      layerTitleRegeneration,
      layerOutbox,
      layerDatabase,
      layerExternalServices,
    ),
    createWorktree,
    removeWorktree,
    renameBranch,
    generateBranchName,
    generateThreadTitle,
    runSetup,
    closeTerminal,
  };
}

function launchInput(input: {
  readonly command: string;
  readonly thread: string;
  readonly message?: string;
  readonly workspace?: ThreadLaunch.ThreadLaunchWorkspaceStrategy;
}) {
  return {
    commandId: CommandId.make(input.command),
    threadId: ThreadId.make(input.thread),
    projectId,
    title: "New thread",
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    workspaceStrategy: input.workspace ?? { type: "root" as const },
    ...(input.message === undefined
      ? {}
      : {
          initialMessage: {
            messageId: MessageId.make(`${input.message}:id`),
            text: input.message,
            attachments: [],
          },
        }),
    createdBy: "user" as const,
    creationSource: "web" as const,
  };
}

function waitUntil<E, R>(predicate: () => Effect.Effect<boolean, E, R>): Effect.Effect<void, E, R> {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (yield* predicate()) return;
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            setImmediate(resolve);
          }),
      );
    }
    assert.fail("Condition was not reached before timeout.");
  });
}

it.effect(
  "scheduled one-shot messages start idle threads, steer working threads and replay without duplicates",
  () => {
    const harness = makeHarness({
      adapters: [
        {
          ...adapter,
          openSession: (input) =>
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              return {
                instanceId: modelSelection.instanceId,
                driver: ProviderDriverKind.make("codex"),
                providerSessionId: input.providerSessionId,
                providerSession: {
                  id: input.providerSessionId,
                  driver: ProviderDriverKind.make("codex"),
                  providerInstanceId: modelSelection.instanceId,
                  status: "ready" as const,
                  cwd: input.runtimePolicy.cwd ?? process.cwd(),
                  model: modelSelection.model,
                  capabilities: CodexProviderCapabilitiesV2,
                  createdAt: now,
                  updatedAt: now,
                  lastError: null,
                },
                events: Stream.never,
                ensureThread: () => Effect.die("unused"),
                resumeThread: () => Effect.die("unused"),
                startTurn: () => Effect.void,
                steerTurn: () => Effect.void,
                interruptTurn: () => Effect.void,
                respondToRuntimeRequest: () => Effect.void,
                readThreadSnapshot: () => Effect.die("unused"),
                rollbackThread: () => Effect.die("unused"),
                forkThread: () => Effect.die("unused"),
              };
            }),
        },
      ],
    });
    const layerTasks = ScheduledTasks.layer
      .pipe(Layer.provide(ScheduledTaskStateTest.layer))
      .pipe(
        Layer.provide(
          Layer.mergeAll(
            harness.layer,
            NodeCrypto.layer,
            Scheduler.layer,
            Layer.mock(SecretRequests.SecretRequests)({}),
          ),
        ),
      );
    return Effect.gen(function* () {
      const tasks = yield* ScheduledTasks.ScheduledTaskService;
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sink = yield* EventSink.EventSinkV2;
      const launched = yield* launches.launch(
        launchInput({ command: "scheduled-once:create", thread: "scheduled-once:thread" }),
      );
      const now = yield* DateTime.now;
      const first = yield* tasks.upsert({
        id: ScheduledTaskId.make("scheduled-once:first"),
        title: "First message",
        prompt: "Start the review",
        enabled: false,
        schedule: { type: "once", runAt: DateTime.formatIso(DateTime.add(now, { hours: 1 })) },
        projectId,
        threadId: launched.threadId,
        workspaceStrategy: { type: "root" },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        creationSource: "web",
      });
      assert.equal((yield* tasks.runNow({ id: first.task.id })).task.lastRunStatus, "succeeded");
      const started = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(started.messages.length, 1);
      assert.equal(
        started.turnItems.find((item) => item.type === "user_message")?.inputIntent,
        "turn_start",
      );
      const run = started.runs[0]!;
      assert.isNotNull(run.activeAttemptId);
      assert.isNotNull(run.providerThreadId);
      const early = yield* tasks.upsert({
        ...first.task,
        id: ScheduledTaskId.make("scheduled-once:early"),
        prompt: "Include the deployment",
        createdBy: "agent",
        creationSource: "server",
      });
      assert.equal((yield* tasks.runNow({ id: early.task.id })).task.lastRunStatus, "succeeded");
      const pending = (yield* threads.getThreadProjection(launched.threadId)).runs.at(-1)!;
      assert.equal(pending.status, "queued");
      assert.equal(pending.steerWhenLiveRunId, run.id);
      // The effect worker is disabled in this harness. Record the provider's
      // running milestone directly, then exercise the real dispatch policy.
      const providerSessionId = ProviderSessionId.make("scheduled-once:session");
      const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
      yield* sessions.open({
        threadId: launched.threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy: {
          cwd: process.cwd(),
          runtimeMode: "full-access",
          interactionMode: "default",
        },
      });
      yield* sink.write({
        events: [
          {
            id: EventId.make("scheduled-once:session-ready"),
            type: "provider-session.attached",
            threadId: launched.threadId,
            occurredAt: now,
            payload: {
              id: providerSessionId,
              driver: ProviderDriverKind.make("codex"),
              providerInstanceId: modelSelection.instanceId,
              status: "ready",
              cwd: "/repo",
              model: modelSelection.model,
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
          },
          {
            id: EventId.make("scheduled-once:thread-ready"),
            type: "provider-thread.updated",
            threadId: launched.threadId,
            occurredAt: now,
            payload: { ...started.providerThreads[0]!, providerSessionId },
          },
          {
            id: EventId.make("scheduled-once:running"),
            type: "run.updated",
            threadId: launched.threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "running" },
          },
          {
            id: EventId.make("scheduled-once:provider-running"),
            type: "provider-turn.updated",
            threadId: launched.threadId,
            runId: run.id,
            nodeId: run.rootNodeId!,
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: ProviderTurnId.make("scheduled-once:turn"),
              providerThreadId: run.providerThreadId!,
              nodeId: run.rootNodeId!,
              runAttemptId: run.activeAttemptId!,
              nativeTurnRef: null,
              ordinal: 1,
              status: "running",
              startedAt: now,
              completedAt: null,
            },
          },
        ],
      });
      yield* sink.stream({ afterSequence: 0, threadId: launched.threadId }).pipe(
        Stream.filter(
          ({ event }) =>
            event.type === "run.updated" &&
            event.payload.id === pending.id &&
            event.payload.status === "cancelled",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      const followup = yield* tasks.upsert({
        ...first.task,
        id: ScheduledTaskId.make("scheduled-once:followup"),
        prompt: "Also check the migrations",
        schedule: {
          type: "once",
          runAt: DateTime.formatIso(DateTime.add(now, { hours: 2 })),
          prepareWorkspace: true,
        },
      });
      const followupResult = yield* tasks.runNow({ id: followup.task.id });
      assert.equal(
        followupResult.task.lastRunStatus,
        "succeeded",
        followupResult.task.lastRunError ?? undefined,
      );
      const steered = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(steered.messages.length, 3);
      assert.equal(
        steered.turnItems
          .filter((item) => item.type === "user_message")
          .find((item) => item.text === "Also check the migrations")?.inputIntent,
        "steer",
      );
      assert.equal(steered.runs.length, 2);
      // A repeated delivery reuses the durable command receipt, even while a turn runs.
      yield* tasks.runNow({ id: followup.task.id });
      assert.equal((yield* threads.getThreadProjection(launched.threadId)).messages.length, 3);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE scheduled_tasks SET last_run_status = 'running' WHERE task_id = ${followup.task.id}`;
      // Rebuild only the scheduler service against the same durable orchestration
      // state to recover a crash after normal delivery accepted the message.
      yield* Effect.gen(function* () {
        const restarted = yield* ScheduledTasks.ScheduledTaskService;
        assert.equal(
          (yield* restarted.runNow({ id: followup.task.id })).task.lastRunStatus,
          "succeeded",
        );
        assert.equal((yield* threads.getThreadProjection(launched.threadId)).messages.length, 3);
      }).pipe(
        Effect.provide(
          ScheduledTasks.layer
            .pipe(Layer.provide(ScheduledTaskStateTest.layer))
            .pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeCrypto.layer,
                  Scheduler.layer,
                  Layer.mock(SecretRequests.SecretRequests)({}),
                ),
              ),
            ),
        ),
      );
    }).pipe(Effect.provide(Layer.mergeAll(harness.layer, layerTasks)));
  },
);

it.effect.each(
  (["new", "existing"] as const).flatMap((target) =>
    (["user", "agent"] as const).map((createdBy) => ({ target, createdBy })),
  ),
)(
  "attributes $createdBy-configured automations in $target threads without changing their prompt",
  ({ target, createdBy }) => {
    const harness = makeHarness();
    const layerScheduledTasks = ScheduledTasks.layer
      .pipe(Layer.provide(ScheduledTaskStateTest.layer))
      .pipe(
        Layer.provide(
          Layer.mergeAll(
            harness.layer,
            NodeCrypto.layer,
            Scheduler.layer,
            Layer.mock(SecretRequests.SecretRequests)({}),
          ),
        ),
      );
    return Effect.gen(function* () {
      const tasks = yield* ScheduledTasks.ScheduledTaskService;
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const existing =
        target === "existing"
          ? yield* launches.launch(
              launchInput({ command: "command:existing", thread: "thread:existing" }),
            )
          : null;
      const { task } = yield* tasks.upsert({
        id: ScheduledTaskId.make("scheduled-task:attribution"),
        title: "Daily audit",
        prompt: "Audit performance and crashes.",
        enabled: false,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId,
        threadId: existing?.threadId ?? null,
        workspaceStrategy: { type: "root" },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy,
        creationSource: createdBy === "agent" ? "mcp" : "web",
      });
      const result = yield* tasks.runNow({ id: task.id });
      assert.equal(result.task.lastRunStatus, "succeeded");
      const projectThreads = yield* threads.listProjectThreads({
        projectId,
        includeSubagents: false,
      });
      const thread =
        projectThreads.find((candidate) => candidate.id === existing?.threadId) ??
        projectThreads[0];
      assert.isDefined(thread);
      const projection = yield* threads.getThreadProjection(thread!.id);
      // Encoding the persisted projection exercises both message and turn-item wire schemas.
      const wire = yield* encodeThreadProjection(projection);
      assert.equal(wire.messages[0]?.text, task.prompt);
      assert.equal(wire.messages[0]?.scheduledTaskId, task.id);
      assert.equal(wire.messages[0]?.createdBy, createdBy);
      const turnItem = wire.turnItems.find(
        (item): item is Extract<typeof item, { type: "user_message" }> =>
          item.type === "user_message",
      );
      assert.equal(turnItem?.text, task.prompt);
      assert.equal(turnItem?.scheduledTaskId, task.id);
    }).pipe(Effect.provide(Layer.mergeAll(harness.layer, layerScheduledTasks)));
  },
);

it.effect.each(
  [undefined, false, true].flatMap((accountPinned) =>
    [false, true].map((bound) => ({ accountPinned, bound })),
  ),
)(
  "scheduled account pin $accountPinned survives storage and dispatch (bound: $bound)",
  ({ accountPinned, bound }) => {
    const secondId = ProviderInstanceId.make("codex_work");
    const account = (instanceId: ProviderInstanceId, usedPercent: number): ServerProvider => ({
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      continuation: { groupKey: "codex:shared" },
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-11-16T12:00:00.000Z",
      models: [{ slug: modelSelection.model, name: "Model", isCustom: false, capabilities: null }],
      slashCommands: [],
      skills: [],
      usageLimits: {
        checkedAt: "2026-11-16T12:00:00.000Z",
        windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent }],
      },
    });
    const harness = makeHarness({
      providers: [account(modelSelection.instanceId, 95), account(secondId, 3)],
      adapters: [adapter, { ...adapter, instanceId: secondId }],
      serverSettings: {
        balanceAccounts: true,
        providerInstances: { [secondId]: { driver: ProviderDriverKind.make("codex"), config: {} } },
      },
    });
    const layerTasks = ScheduledTasks.layer.pipe(
      Layer.provide(ScheduledTaskStateTest.layer),
      Layer.provide(
        Layer.mergeAll(
          harness.layer,
          NodeCrypto.layer,
          Scheduler.layer,
          Layer.mock(SecretRequests.SecretRequests)({}),
        ),
      ),
    );
    return Effect.gen(function* () {
      const tasks = yield* ScheduledTasks.ScheduledTaskService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const launch = yield* ThreadLaunch.ThreadLaunchService;
      const sql = yield* SqlClient.SqlClient;
      const existing = bound
        ? yield* launch.launch(launchInput({ command: "pinned:bound", thread: "pinned:bound" }))
        : null;
      const selection = { ...modelSelection, ...(bound ? { instanceId: secondId } : {}) };
      const saved = yield* tasks.upsert({
        title: "Account choice",
        prompt: "Check progress",
        enabled: false,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId,
        threadId: existing?.threadId ?? null,
        workspaceStrategy: { type: "root" },
        modelSelection: selection,
        ...(accountPinned === undefined ? {} : { accountPinned }),
        runtimeMode: "full-access",
        interactionMode: "default",
        creationSource: "web",
      });
      const ran = yield* tasks.runNow({ id: saved.task.id });
      assert.equal(ran.task.lastRunStatus, "succeeded");
      const occurrence = (yield* tasks.listRuns({ id: saved.task.id })).runs[0]!;
      const projection = yield* threads.getThreadProjection(occurrence.threadId!);
      const expected = bound || accountPinned === true ? modelSelection.instanceId : secondId;
      assert.equal(projection.thread.modelSelection.instanceId, expected);
      assert.equal(projection.runs[0]!.modelSelection.instanceId, expected);
      assert.deepEqual(ran.task.modelSelection, selection);
      const loaded = (yield* tasks.list()).tasks.find((task) => task.id === saved.task.id)!;
      assert.equal(loaded.accountPinned === true, accountPinned === true);
      const rows = yield* sql<{
        model_selection_json: string;
      }>`SELECT model_selection_json FROM scheduled_tasks WHERE task_id = ${saved.task.id}`;
      assert.deepEqual(JSON.parse(rows[0]!.model_selection_json), {
        ...selection,
        ...(accountPinned ? { accountPinned: true } : {}),
      });
      // Editing and then clearing the pin reverts to balancing without changing the selection.
      const cleared = yield* tasks.upsert({ ...loaded, accountPinned: false });
      assert.equal(cleared.task.accountPinned === true, false);
      const clearedRows = yield* sql<{
        model_selection_json: string;
      }>`SELECT model_selection_json FROM scheduled_tasks WHERE task_id = ${saved.task.id}`;
      assert.deepEqual(JSON.parse(clearedRows[0]!.model_selection_json), selection);
    }).pipe(Effect.provide(Layer.mergeAll(harness.layer, layerTasks)));
  },
);

const quotaAccount = (instanceId: string, usedPercent: number): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make("codex"),
  displayName: instanceId === "codex" ? "Codex" : "Work",
  continuation: { groupKey: "codex:home:/synthetic/.codex" },
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-16T12:00:00.000Z",
  models: [
    { slug: modelSelection.model, name: "GPT-5.1 Codex", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: "2026-11-16T12:00:00.000Z",
    windows: [{ id: "primary", kind: "weekly", label: "Weekly", usedPercent }],
  },
});

it.effect("keeps an unattended launch on the account offering its selected tier", () => {
  const account = (id: string, used: number, tiers: string[]): ServerProvider => {
    const snapshot = quotaAccount(id, used);
    return {
      ...snapshot,
      models: snapshot.models.map((entry) => ({
        ...entry,
        capabilities: {
          optionDescriptors: [
            {
              type: "select",
              id: "serviceTier",
              label: "Speed",
              options: tiers.map((tier) => ({ id: tier, label: tier })),
            },
          ],
        },
      })),
    };
  };
  const secondId = ProviderInstanceId.make("codex_work");
  const harness = makeHarness({
    providers: [
      account("codex", 80, ["ultrafast", "priority"]),
      account(secondId, 10, ["priority"]),
    ],
    serverSettings: {
      balanceAccounts: true,
      providerInstances: { [secondId]: { driver: ProviderDriverKind.make("codex"), config: {} } },
    },
  });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const selection = { ...modelSelection, options: [{ id: "serviceTier", value: "ultrafast" }] };
    const launch = yield* launches.launch({
      ...launchInput({ command: "tier:create", thread: "tier:thread" }),
      modelSelection: selection,
      preferAccountWithRoom: true,
    });
    assert.deepEqual(
      (yield* threads.getThreadProjection(launch.threadId)).thread.modelSelection,
      selection,
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("bases a new unattended launch on refreshed quota for just its eligible accounts", () => {
  const second = ProviderInstanceId.make("codex_work");
  const cached = [
    quotaAccount("codex", 10),
    quotaAccount(second, 80),
    { ...quotaAccount("other", 1), continuation: { groupKey: "unrelated" } },
  ];
  const readQuota = vi.fn(() =>
    Effect.succeed([quotaAccount("codex", 96), quotaAccount(second, 20)]),
  );
  const harness = makeHarness({
    providers: cached,
    readQuota,
    serverSettings: {
      balanceAccounts: true,
      providerInstances: { [second]: { driver: ProviderDriverKind.make("codex"), config: {} } },
    },
  });
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-17T04:00:00Z"));
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const result = yield* launches.launch({
      ...launchInput({ command: "stale:start", thread: "stale:thread" }),
      preferAccountWithRoom: true,
    });
    assert.equal(
      (yield* threads.getThreadProjection(result.threadId)).thread.modelSelection.instanceId,
      second,
    );
    assert.deepEqual(readQuota.mock.calls, [[[modelSelection.instanceId, second]]]);
    yield* launches.launch({
      ...launchInput({ command: "pin:start", thread: "pin:thread" }),
      preferAccountWithRoom: false,
    });
    assert.equal(readQuota.mock.calls.length, 1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("starts an unattended launch on the sibling account that has room", () => {
  const harness = makeHarness({
    serverSettings: {
      balanceAccounts: true,
      providerInstances: {
        [ProviderInstanceId.make("codex_work")]: {
          driver: ProviderDriverKind.make("codex"),
          config: {},
        },
      },
    },
    providers: [
      quotaAccount("codex", 95),
      {
        ...quotaAccount("codex_work", 3),
        recentFailure: {
          kind: "usage_limit",
          modelIds: ["another-model"],
          message: "Model limit reached.",
          occurredAt: "2026-11-17T16:00:00.000Z",
          resetAt: "2999-01-01T00:00:00.000Z",
        },
      },
    ],
  });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const startedOn = (command: string, thread: string, preferAccountWithRoom: boolean) =>
      launches.launch({ ...launchInput({ command, thread }), preferAccountWithRoom }).pipe(
        Effect.flatMap((result) => threads.getThreadProjection(result.threadId)),
        Effect.map((projection) => projection.thread.modelSelection),
      );

    // A schedule asks for the account with room; the model stays the same.
    assert.deepStrictEqual(yield* startedOn("command:room", "thread:room", true), {
      instanceId: ProviderInstanceId.make("codex_work"),
      model: modelSelection.model,
    });
    // A chat somebody starts keeps the account that was picked.
    assert.equal(
      (yield* startedOn("command:picked", "thread:picked", false)).instanceId,
      modelSelection.instanceId,
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("starts an unattended launch on the sibling while its account is signed out", () => {
  const harness = makeHarness({
    serverSettings: {
      balanceAccounts: true,
      providerInstances: {
        [ProviderInstanceId.make("codex_work")]: {
          driver: ProviderDriverKind.make("codex"),
          config: {},
        },
      },
    },
    providers: [
      {
        // The roomier account, until its login stopped working.
        ...quotaAccount("codex", 5),
        recentFailure: {
          kind: "authentication_error",
          message: "Signed out. Sign in again.",
          occurredAt: "2026-11-17T16:00:00.000Z",
        },
      },
      quotaAccount("codex_work", 60),
    ],
  });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const startedOn = (command: string, thread: string, preferAccountWithRoom: boolean) =>
      launches.launch({ ...launchInput({ command, thread }), preferAccountWithRoom }).pipe(
        Effect.flatMap((result) => threads.getThreadProjection(result.threadId)),
        Effect.map((projection) => projection.thread.modelSelection.instanceId),
      );
    assert.equal(
      yield* startedOn("command:signed-out", "thread:signed-out", true),
      ProviderInstanceId.make("codex_work"),
    );
    // A hand pick stays where it was put, signed out or not.
    assert.equal(
      yield* startedOn("command:signed-out-picked", "thread:signed-out-picked", false),
      modelSelection.instanceId,
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect.each(["new-chat", "scheduled"] as const)(
  "keeps hidden sibling models out of %s launches",
  (kind) => {
    const secondId = ProviderInstanceId.make("codex_work");
    const harness = makeHarness({
      providers: [quotaAccount("codex", 95), quotaAccount("codex_work", 3)],
      adapters: [adapter, { ...adapter, instanceId: secondId }],
      serverSettings: {
        balanceAccounts: true,
        providerInstances: { [secondId]: { driver: ProviderDriverKind.make("codex"), config: {} } },
        providerModelPreferences: {
          [secondId]: { hiddenModels: [modelSelection.model], modelOrder: [] },
        },
      },
    });
    const layerTasks = ScheduledTasks.layer.pipe(
      Layer.provide(ScheduledTaskStateTest.layer),
      Layer.provide(
        Layer.mergeAll(
          harness.layer,
          NodeCrypto.layer,
          Scheduler.layer,
          Layer.mock(SecretRequests.SecretRequests)({}),
        ),
      ),
    );
    return Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      let threadId: ThreadId;
      if (kind === "new-chat") {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        threadId = (yield* launches.launch({
          ...launchInput({ command: "hidden:create", thread: "hidden:thread" }),
          preferAccountWithRoom: true,
        })).threadId;
      } else {
        const tasks = yield* ScheduledTasks.ScheduledTaskService;
        const saved = yield* tasks.upsert({
          title: "Hidden account",
          prompt: "Review this diff.",
          enabled: false,
          schedule: { type: "interval", everyMs: 3600000 },
          projectId,
          threadId: null,
          workspaceStrategy: { type: "root" },
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          creationSource: "web",
        });
        const ran = yield* tasks.runNow({ id: saved.task.id });
        assert.equal(ran.task.lastRunStatus, "succeeded");
        threadId = (yield* tasks.listRuns({ id: saved.task.id })).runs[0]!.threadId!;
      }
      assert.equal(
        (yield* threads.getThreadProjection(threadId)).thread.modelSelection.instanceId,
        modelSelection.instanceId,
      );
    }).pipe(Effect.provide(Layer.mergeAll(harness.layer, layerTasks)));
  },
);

it.effect("a retried launch keeps the account its chat was created on", () => {
  const secondId = ProviderInstanceId.make("codex_work");
  const account = (instanceId: ProviderInstanceId, usedPercent: number): ServerProvider => ({
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    continuation: { groupKey: "codex:home:/synthetic/.codex" },
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-16T12:00:00.000Z",
    models: [
      { slug: modelSelection.model, name: "GPT-5.1 Codex", isCustom: false, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: "2026-11-16T12:00:00.000Z",
      windows: [{ id: "primary", kind: "weekly", label: "Weekly", usedPercent }],
    },
  });
  const harness = makeHarness({
    // By now the account asked for has the most room again.
    providers: [account(modelSelection.instanceId, 4), account(secondId, 40)],
    adapters: [adapter, { ...adapter, instanceId: secondId }],
    serverSettings: {
      providerInstances: { [secondId]: { driver: ProviderDriverKind.make("codex"), config: {} } },
    },
  });
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const request = {
      ...launchInput({ command: "command:retry", thread: "thread:retry", message: "hello" }),
      preferAccountWithRoom: true,
    };
    // What a first attempt leaves when it stops after creating the chat on the other
    // account and before sending its first message.
    yield* threads.dispatch({
      type: "thread.create",
      commandId: request.commandId,
      threadId: request.threadId,
      projectId,
      title: request.title,
      modelSelection: { ...modelSelection, instanceId: secondId },
      runtimeMode: request.runtimeMode,
      interactionMode: request.interactionMode,
      branch: null,
      worktreePath: null,
      createdBy: request.createdBy,
      creationSource: request.creationSource,
    });
    const result = yield* launches.launch(request);
    assert.equal(result.projection.thread.modelSelection.instanceId, secondId);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("retains automation and sender attribution while a message waits in the queue", () => {
  const harness = makeHarness({ runSetup: () => Effect.never });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch(
      launchInput({
        command: "command:automation:queue",
        thread: "thread:automation:queue",
        message: "First message",
      }),
    );
    const scheduledTaskId = ScheduledTaskId.make("scheduled-task:queued");
    const senderThreadId = ThreadId.make("thread:agent-sender");
    const queued = yield* threads.sendToThread({
      projectId,
      commandId: CommandId.make("command:automation:queued"),
      threadId: launched.threadId,
      messageId: MessageId.make("message:automation:queued"),
      scheduledTaskId,
      senderThreadId,
      text: "Run the audit",
      attachments: [],
      mode: "queue",
      createdBy: "agent",
      creationSource: "mcp",
    });
    assert.equal(queued.delivery, "queued");
    const projection = yield* threads.getThreadProjection(launched.threadId);
    const message = projection.messages.find((item) => item.id === queued.message.id);
    assert.equal(message?.scheduledTaskId, scheduledTaskId);
    assert.equal(message?.senderThreadId, senderThreadId);
    assert.equal(message?.text, "Run the audit");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("returns a visible preparing message while provisioning is still blocked", () =>
  Effect.gen(function* () {
    const worktreeEntered = yield* Deferred.make<void>();
    const allowWorktree = yield* Deferred.make<void>();
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      createWorktree: () =>
        Deferred.succeed(worktreeEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowWorktree)),
          Effect.as({
            worktree: { path: "/repo-worktrees/feature", refName: "feature", headSha: "abc" },
          } as never),
        ),
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const input = launchInput({
        command: "command:launch:blocked",
        thread: "thread:launch:blocked",
        message: "Build the feature",
        workspace: { type: "worktree", baseRef: "main" },
      });
      const launched = yield* launches.launch(input);
      assert.equal(launched.projection.messages[0]?.text, "Build the feature");
      assert.equal(launched.projection.runs[0]?.status, "preparing");
      assert.equal(
        launched.projection.turnItems.find((item) => item.type === "command_execution")?.status,
        "running",
      );
      yield* Deferred.await(worktreeEntered);
      let current = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(
        current.turnItems.find((item) => item.type === "command_execution")?.title,
        "Preparing worktree",
      );
      yield* Deferred.succeed(allowWorktree, undefined);
      const entered = yield* Deferred.await(setupEntered).pipe(
        Effect.timeoutOption(Duration.seconds(2)),
      );
      if (Option.isNone(entered)) {
        current = yield* threads.getThreadProjection(launched.threadId);
        assert.fail(
          `Setup was not reached; run=${current.runs[0]?.status ?? "missing"}, worklog=${current.turnItems.find((item) => item.type === "command_execution")?.title ?? "missing"}.`,
        );
      }
      current = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(
        current.turnItems.find((item) => item.type === "command_execution")?.title,
        "Starting setup script",
      );
      const prematureEffects = yield* outbox.listByCommandId(
        CommandId.make("command:launch:blocked:initial-message"),
      );
      assert.isEmpty(prematureEffects);
      yield* Deferred.succeed(allowSetup, undefined);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("provisions independent launches concurrently instead of behind a global semaphore", () =>
  Effect.gen(function* () {
    const setupCount = yield* Ref.make(0);
    const bothEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Ref.updateAndGet(setupCount, (count) => count + 1).pipe(
          Effect.tap((count) =>
            count === 2 ? Deferred.succeed(bothEntered, undefined) : Effect.void,
          ),
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const results = yield* Effect.all(
        [
          launches.launch(
            launchInput({
              command: "command:launch:concurrent-a",
              thread: "thread:launch:concurrent-a",
              message: "First",
            }),
          ),
          launches.launch(
            launchInput({
              command: "command:launch:concurrent-b",
              thread: "thread:launch:concurrent-b",
              message: "Second",
            }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(
        results.map((result) => result.projection.runs[0]?.status),
        ["preparing", "preparing"],
      );
      yield* Deferred.await(bothEntered);
      assert.equal(yield* Ref.get(setupCount), 2);
      yield* Deferred.succeed(allowSetup, undefined);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("enqueues provider work only after setup has been initiated", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({
            status: "started" as const,
            async: false,
            scriptId: "setup",
            scriptName: "Setup",
            scriptCommand: "vp install",
            terminalId: "setup",
            cwd: "/repo",
          }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const input = launchInput({
        command: "command:launch:release",
        thread: "thread:launch:release",
        message: "Start after setup",
        workspace: { type: "worktree", baseRef: "main" },
      });
      const launched = yield* launches.launch(input);
      yield* Deferred.await(setupEntered);
      assert.isEmpty(
        yield* outbox.listByCommandId(CommandId.make("command:launch:release:release")),
      );
      yield* Deferred.succeed(allowSetup, undefined);
      yield* waitUntil(() =>
        outbox
          .listByCommandId(CommandId.make("command:launch:release:release"))
          .pipe(Effect.map((effects) => effects.length === 1)),
      );
      const projection = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(projection.runs[0]?.status, "starting");
      assert.equal(projection.checkpointScopes[0]?.cwd, "/repo-worktrees/feature");
      assert.equal(
        projection.turnItems.find((item) => item.type === "command_execution")?.status,
        "completed",
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect(
  "queues follow-up messages behind preparation and checkpoints them in the final workspace",
  () =>
    Effect.gen(function* () {
      const setupEntered = yield* Deferred.make<void>();
      const failSetup = yield* Deferred.make<void>();
      const harness = makeHarness({
        runSetup: () =>
          Deferred.succeed(setupEntered, undefined).pipe(
            Effect.andThen(Deferred.await(failSetup)),
            Effect.andThen(Effect.fail(new Error("setup failed") as never)),
          ),
      });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const launched = yield* launches.launch(
          launchInput({
            command: "command:launch:queued-during-preparation",
            thread: "thread:launch:queued-during-preparation",
            message: "Prepare the workspace",
            workspace: { type: "worktree", baseRef: "main" },
          }),
        );
        yield* Deferred.await(setupEntered);

        const followUp = yield* threads.sendToThread({
          projectId,
          commandId: CommandId.make("command:launch:queued-follow-up"),
          threadId: launched.threadId,
          messageId: MessageId.make("message:launch:queued-follow-up"),
          text: "Run after preparation",
          attachments: [],
          mode: "auto",
          createdBy: "user",
          creationSource: "web",
        });
        assert.equal(followUp.delivery, "queued");
        assert.equal(followUp.run.status, "queued");
        assert.equal(
          (yield* threads.getThreadRecords(launched.threadId, ["nodes"])).nodes.find(
            (node) => node.runId === followUp.run.id && node.kind === "root_turn",
          )?.checkpointScopeId,
          null,
        );

        yield* Deferred.succeed(failSetup, undefined);
        yield* waitUntil(() =>
          threads
            .getThreadProjection(launched.threadId)
            .pipe(
              Effect.map(
                (projection) =>
                  projection.runs.find((run) => run.id === followUp.run.id)?.status === "starting",
              ),
            ),
        );

        const projection = yield* threads.getThreadProjection(launched.threadId);
        const rootNode = projection.nodes.find(
          (node) => node.runId === followUp.run.id && node.kind === "root_turn",
        );
        assert.isNotNull(rootNode?.checkpointScopeId);
        assert.equal(
          projection.checkpointScopes.find((scope) => scope.id === rootNode?.checkpointScopeId)
            ?.cwd,
          "/repo-worktrees/feature",
        );
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect.each([" /COMPACT ", "/logout"])(
  "uses the first conversation message for a title after %s",
  (nativeCommand) =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const launched = yield* launches.launch({
          ...launchInput({
            command: "compact-title",
            thread: "compact-title-thread",
            message: nativeCommand,
          }),
          generateTitle: true,
        });
        assert.isUndefined(
          (yield* threads.getThreadProjection(launched.threadId)).thread.titleRegeneration,
        );
        assert.isFalse(
          (yield* outbox.listByCommandId(CommandId.make("compact-title:initial-message"))).some(
            (effect) => effect.request.type === "thread-title.generate",
          ),
        );
        const commandId = CommandId.make("compact-title-conversation");
        const messageId = MessageId.make("compact-title-conversation-message");
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId,
          threadId: launched.threadId,
          messageId,
          createdBy: "user",
          creationSource: "web",
          text: "Fix the failing parser",
          attachments: [],
          dispatchMode: { type: "defer_start" },
        });
        assert.equal(
          (yield* threads.getThreadProjection(launched.threadId)).thread.titleRegeneration
            ?.requestId,
          commandId,
        );
        assert.deepEqual(
          (yield* outbox.listByCommandId(commandId))
            .filter((effect) => effect.request.type === "thread-title.generate")
            .map((effect) => effect.request),
          [{ type: "thread-title.generate", kind: { type: "initial", messageId } }],
        );
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect("keeps native maintenance commands out of steering and restart messages", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      for (const scenario of [
        {
          name: "compact-steer",
          first: "Fix the parser",
          next: " /COMPACT ",
          mode: "steer_active",
        },
        {
          name: "compact-restart",
          first: "Fix the parser",
          next: "/compact",
          mode: "restart_active",
        },
        {
          name: "compact-instructions-steer",
          first: "Fix the parser",
          next: "/compact keep the API details",
          mode: "steer_active",
        },
        {
          name: "compact-instructions-restart",
          first: "Fix the parser",
          next: "/compact keep the API details",
          mode: "restart_active",
        },
        {
          name: "steer-compaction-instructions",
          first: "/compact keep the API details",
          next: "Continue with the parser",
          mode: "steer_active",
        },
        {
          name: "logout-steer",
          first: "Fix the parser",
          next: "/logout",
          mode: "steer_active",
        },
        {
          name: "logout-restart",
          first: "Fix the parser",
          next: "/logout",
          mode: "restart_active",
        },
        {
          name: "steer-logout",
          first: "/logout",
          next: "Continue with the parser",
          mode: "steer_active",
        },
        {
          name: "steer-compaction",
          first: "/compact",
          next: "Continue with the parser",
          mode: "steer_active",
        },
      ] as const) {
        const launched = yield* launches.launch(
          launchInput({
            command: `${scenario.name}:launch`,
            thread: scenario.name,
            message: scenario.first,
          }),
        );
        const before = yield* threads.getThreadProjection(launched.threadId);
        const targetRun = before.runs[0];
        if (targetRun === undefined) return yield* Effect.die("Launch must create a run");
        const commandId = CommandId.make(`${scenario.name}:message`);
        const dispatch = threads.dispatch({
          type: "message.dispatch",
          commandId,
          threadId: launched.threadId,
          messageId: MessageId.make(`${scenario.name}:message`),
          createdBy: "user",
          creationSource: "web",
          text: scenario.next,
          attachments: [],
          dispatchMode: { type: scenario.mode, targetRunId: targetRun.id },
        });
        // A steer sent while a maintenance turn runs waits as a queued follow-up.
        if (scenario.name.startsWith("steer-")) {
          yield* dispatch;
          const queued = (yield* threads.getThreadProjection(launched.threadId)).runs[1];
          assert.equal(queued?.status, "queued");
          assert.equal(queued?.userMessageId, MessageId.make(`${scenario.name}:message`));
          continue;
        }
        const failure = yield* dispatch.pipe(Effect.flip);
        assert.include(
          String(failure.cause).toLowerCase(),
          scenario.name.includes("logout") ? "sign" : "context compaction",
        );
        const after = yield* threads.getThreadProjection(launched.threadId);
        assert.deepEqual(after.messages, before.messages);
        assert.deepEqual(after.thread.titleRegeneration, before.thread.titleRegeneration);
        assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
      }
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("arms durable title generation after accepting the first message", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      generateTitle: (input) =>
        Effect.succeed({
          title: input.previousTitle === undefined ? "Generated title" : "Regenerated title",
        }),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
      const input = {
        ...launchInput({
          command: "command:launch:title-generation",
          thread: "thread:launch:title-generation",
          message: "Generate my title",
        }),
        title: "Generate my title",
        generateTitle: true,
      };
      const launched = yield* launches.launch(input);
      const generationCommandId = CommandId.make("command:launch:title-generation:initial-message");

      const projection = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(projection.thread.title, "Generate my title");
      assert.equal(projection.thread.titleRegeneration?.requestId, generationCommandId);
      assert.deepEqual(
        (yield* outbox.listByCommandId(generationCommandId)).map((effect) => effect.request),
        [
          {
            type: "thread-title.generate",
            kind: { type: "initial", messageId: MessageId.make("Generate my title:id") },
          },
        ],
      );
      yield* titleRegeneration.execute({
        threadId: launched.threadId,
        requestId: generationCommandId,
        kind: { type: "initial", messageId: MessageId.make("Generate my title:id") },
      });
      const generated = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(generated.thread.title, "Generated title");
      assert.deepEqual(
        harness.generateThreadTitle.mock.calls[0]?.[0]?.modelSelection,
        DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
      );

      const manualRequestId = CommandId.make("command:title-generation:manual");
      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: manualRequestId,
        threadId: launched.threadId,
        regenerateTitle: true,
      });
      assert.deepEqual(
        (yield* outbox.listByCommandId(manualRequestId)).map((effect) => effect.request),
        [{ type: "thread-title.generate", kind: { type: "regenerate" } }],
      );
      yield* titleRegeneration.execute({
        threadId: launched.threadId,
        requestId: manualRequestId,
        kind: { type: "regenerate" },
      });
      const regenerated = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(regenerated.thread.title, "Regenerated title");
      assert.equal(
        harness.generateThreadTitle.mock.calls[1]?.[0]?.previousTitle,
        "Generated title",
      );

      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("command:title-generation:user-rename"),
        threadId: launched.threadId,
        title: "Keep my title",
      });
      const renamed = yield* threads.getThreadProjection(launched.threadId);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* threads.dispatch({
        type: "thread.title.regeneration.complete",
        commandId: CommandId.make("command:title-generation:stale-completion"),
        threadId: launched.threadId,
        requestId: generationCommandId,
        title: "Stale generated title",
      });
      const afterStaleCompletion = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(afterStaleCompletion.thread.title, "Keep my title");
      assert.equal(
        DateTime.toEpochMillis(afterStaleCompletion.thread.updatedAt),
        DateTime.toEpochMillis(renamed.thread.updatedAt),
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("does not update a reused thread title when the initial message is rejected", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make("thread:launch:reused-title-failure");
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make("command:launch:reused-title-failure:create"),
        threadId,
        projectId,
        title: "Original title",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });

      const commandId = CommandId.make("command:launch:reused-title-failure");
      const failed = yield* launches
        .launch({
          ...launchInput({
            command: commandId,
            thread: threadId,
            message: "Generate a provisional title",
          }),
          reuseExistingThread: true,
          title: "Generate a provisional title",
          generateTitle: true,
          modelSelection: {
            instanceId: ProviderInstanceId.make("missing-provider"),
            model: "missing-model",
          },
        })
        .pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(failed));
      const projection = yield* threads.getThreadProjection(threadId);
      assert.equal(projection.thread.title, "Original title");
      assert.isUndefined(projection.thread.titleRegeneration);
      assert.isEmpty(projection.messages);
      assert.isEmpty(yield* outbox.listByCommandId(CommandId.make(`${commandId}:initial-message`)));
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("generates an initial title for an attachment-only message", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
      const messageId = MessageId.make("message:image-only");
      const input = {
        ...launchInput({
          command: "command:launch:image-only",
          thread: "thread:launch:image-only",
        }),
        title: "Image: screenshot.png",
        generateTitle: true,
        initialMessage: {
          messageId,
          text: "",
          attachments: [
            {
              type: "image" as const,
              id: "attachment-image-only",
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 128,
            },
          ],
        },
      };

      const launched = yield* launches.launch(input);
      yield* titleRegeneration.execute({
        threadId: launched.threadId,
        requestId: CommandId.make("command:launch:image-only:initial-message"),
        kind: { type: "initial", messageId },
      });

      assert.equal(harness.generateThreadTitle.mock.calls[0]?.[0]?.message, "");
      assert.equal(
        harness.generateThreadTitle.mock.calls[0]?.[0]?.attachments?.[0]?.name,
        "screenshot.png",
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("uses the available source control writer for generated worktree branches", () =>
  Effect.gen(function* () {
    const writerInstanceId = ProviderInstanceId.make("source-control-writer");
    const writerModelSelection = {
      instanceId: writerInstanceId,
      model: "branch-writer-model",
    } as const;
    const harness = makeHarness({
      serverSettings: {
        providerInstances: {
          [writerInstanceId]: {
            driver: ProviderDriverKind.make("codex"),
            config: {},
          },
        },
        sourceControlWriterModelSelection: writerModelSelection,
      },
      providers: [
        {
          instanceId: writerInstanceId,
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-07-28T00:00:00.000Z",
          availability: "available",
          models: [],
          slashCommands: [],
          skills: [],
        },
      ],
    });

    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      yield* launches.launch(
        launchInput({
          command: "command:launch:source-control-writer",
          thread: "thread:launch:source-control-writer",
          message: "Generate a branch with the configured writer",
          workspace: { type: "worktree", baseRef: "main" },
        }),
      );
      yield* waitUntil(() => Effect.sync(() => harness.generateBranchName.mock.calls.length === 1));
      assert.deepEqual(
        harness.generateBranchName.mock.calls[0]?.[0]?.modelSelection,
        writerModelSelection,
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("falls back when the source control writer is unavailable", () =>
  Effect.gen(function* () {
    const writerInstanceId = ProviderInstanceId.make("missing-source-control-writer");
    const harness = makeHarness({
      serverSettings: {
        providerInstances: {
          [writerInstanceId]: {
            driver: ProviderDriverKind.make("missing-driver"),
            config: {},
          },
        },
        sourceControlWriterModelSelection: {
          instanceId: writerInstanceId,
          model: "missing-branch-writer-model",
        },
      },
      providers: [],
    });

    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      yield* launches.launch(
        launchInput({
          command: "command:launch:source-control-writer-fallback",
          thread: "thread:launch:source-control-writer-fallback",
          message: "Generate a branch with the available writer",
          workspace: { type: "worktree", baseRef: "main" },
        }),
      );
      yield* waitUntil(() => Effect.sync(() => harness.generateBranchName.mock.calls.length === 1));
      assert.deepEqual(
        harness.generateBranchName.mock.calls[0]?.[0]?.modelSelection,
        DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect(
  "keeps Scratch comparison launches in separate folders with the same original context",
  () =>
    Effect.gen(function* () {
      const setupCount = yield* Ref.make(0);
      const bothEntered = yield* Deferred.make<void>();
      // Only `projectId` stands in for the Scratch project here.
      const claimed: Array<{ readonly threadId: ThreadId; readonly text: string }> = [];
      const harness = makeHarness({
        runSetup: () =>
          Ref.updateAndGet(setupCount, (count) => count + 1).pipe(
            Effect.tap((count) =>
              count === 2 ? Deferred.succeed(bothEntered, undefined) : Effect.void,
            ),
            Effect.andThen(Effect.never),
          ),
        managedFolders: Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          folderForThread: (input) =>
            Effect.sync(() => {
              if (input.projectId !== projectId) return Option.none();
              claimed.push({ threadId: input.threadId, text: input.text });
              return Option.some(`/scratch/folder-${claimed.length}`);
            }),
        }),
      });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const original = {
          text: "Convert these [PNGs](t3-context://v1/file/comparison-design)",
          attachments: [
            {
              type: "image" as const,
              id: "comparison-design",
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
                contextId: ComposerContextId.make("comparison-design"),
                kind: "file" as const,
                label: "design.png",
                attachmentId: "comparison-design",
                name: "design.png",
                mimeType: "image/png",
                sizeBytes: 10,
              },
            ],
          },
        };
        const inputs = ["first-model", "second-model"].map((model) => ({
          ...launchInput({
            command: `command:launch:scratch:${model}`,
            thread: `thread:launch:scratch:${model}`,
          }),
          modelSelection: { ...modelSelection, model },
          initialMessage: { ...original, messageId: MessageId.make(`scratch:${model}`) },
        }));
        const results = yield* Effect.all(
          inputs.map((input) => launches.launch(input)),
          { concurrency: "unbounded" },
        );
        yield* Deferred.await(bothEntered);
        const paths = results.map((result) => result.projection.thread.worktreePath);
        assert.sameMembers(paths, ["/scratch/folder-1", "/scratch/folder-2"]);
        assert.sameMembers(
          harness.runSetup.mock.calls.map(([input]) => input.worktreePath),
          paths,
        );
        assert.equal(harness.createWorktree.mock.calls.length, 0);

        for (const [index, input] of inputs.entries()) {
          const result = results[index]!;
          assert.deepEqual(result.projection.messages[0]?.attachments, original.attachments);
          assert.deepEqual(result.projection.messages[0]?.context, original.context);
          assert.equal(result.projection.messages[0]?.text, original.text);
          assert.equal(result.projection.thread.modelSelection.model, input.modelSelection.model);

          // Lost responses replay the original workspace; shared follow-ups use it too.
          const retried = yield* launches.launch(input);
          assert.isTrue(retried.resumed);
          const followUp = yield* threads.sendToThread({
            projectId,
            commandId: CommandId.make(`follow-up:${index}`),
            threadId: result.threadId,
            messageId: MessageId.make(`follow-up:${index}`),
            text: "Now convert them to WebP",
            attachments: [],
            mode: "queue",
            createdBy: "user",
            creationSource: "web",
          });
          assert.equal(followUp.projection.thread.worktreePath, paths[index]);
          assert.equal(followUp.message.text, "Now convert them to WebP");
        }
        assert.lengthOf(claimed, 2);
        assert.deepEqual(
          claimed.map((claim) => claim.text),
          [original.text, original.text],
        );

        const other = yield* launches.launch({
          ...launchInput({
            command: "command:launch:scratch-other",
            thread: "thread:launch:scratch-other",
            message: "Elsewhere",
          }),
          projectId: otherProjectId,
        });
        assert.lengthOf(claimed, 2);
        assert.isNull(other.projection.thread.worktreePath);
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect("names the worktree itself when the client provides no branch", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const launched = yield* launches.launch(
        launchInput({
          command: "command:launch:server-named-branch",
          thread: "thread:launch:server-named-branch",
          message: "Build the feature",
          workspace: { type: "worktree", baseRef: "main" },
        }),
      );
      yield* waitUntil(() => Effect.sync(() => harness.createWorktree.mock.calls.length === 1));
      assert.match(
        harness.createWorktree.mock.calls[0]?.[0]?.newRefName ?? "",
        /^t3\/[0-9a-f]{8}$/u,
      );
      yield* waitUntil(() =>
        threads
          .getThreadProjection(launched.threadId)
          .pipe(Effect.map((projection) => projection.thread.branch === "generated-branch")),
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect.each(
  [false, true].flatMap((archived) =>
    [false, true].map((parentMoved) => ({ archived, parentMoved })),
  ),
)("renames shared temporary branches with %j", ({ archived, parentMoved }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "launch-rename-" });
    const repo = `${directory}/repo`;
    const worktreePath = `${directory}/shared`;
    const movedPath = `${directory}/moved`;
    yield* fs.makeDirectory(repo);
    const command = (cwd: string, args: string[]) =>
      git.execute({ operation: "launch-test", cwd, args });
    yield* command(repo, ["init", "-b", "main"]);
    yield* command(repo, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ]);
    yield* command(repo, ["worktree", "add", "-b", "t3/abcd1234", worktreePath]);
    yield* command(repo, ["worktree", "add", "-b", "user/checkout", movedPath]);
    const branchNameStarted = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
    const allowBranchName = yield* Deferred.make<void>();
    const harness = makeHarness({
      createWorktree: (input) =>
        Effect.succeed({
          worktree: { path: worktreePath, refName: input.newRefName, headSha: "abc" },
        } as never),
      renameBranch: git.renameBranch,
      generateBranchName: () =>
        Effect.fiber.pipe(
          Effect.flatMap((fiber) => Deferred.succeed(branchNameStarted, fiber)),
          Effect.andThen(Deferred.await(allowBranchName)),
          Effect.as({ branch: "generated-branch" }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const launched = yield* launches.launch(
        launchInput({
          command: "command:launch:temp-branch",
          thread: "thread:launch:temp-branch",
          message: "Build the feature",
          workspace: { type: "worktree", baseRef: "main", branch: "t3/abcd1234" },
        }),
      );
      const renameFiber = yield* Deferred.await(branchNameStarted);
      assert.equal(harness.createWorktree.mock.calls[0]?.[0]?.newRefName, "t3/abcd1234");
      yield* waitUntil(() =>
        threads
          .getThreadProjection(launched.threadId)
          .pipe(Effect.map((projection) => projection.runs[0]?.status === "starting")),
      );
      assert.equal(
        (yield* threads.getThreadProjection(launched.threadId)).thread.branch,
        "t3/abcd1234",
      );
      const parent = yield* threads.getThreadProjection(launched.threadId);
      const run = parent.runs[0]!;
      assert.isNotNull(run.rootNodeId);
      yield* threads.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("command:launch:temp-branch:delegate"),
        parentThreadId: launched.threadId,
        parentRunId: run.id,
        parentNodeId: run.rootNodeId!,
        task: "Work in the parent's checkout",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      });
      const delegated = yield* threads.getThreadProjection(launched.threadId);
      const childThreadId = delegated.subagents[0]!.childThreadId!;
      const child = yield* threads.getThreadProjection(childThreadId);
      assert.equal(child.thread.branch, "t3/abcd1234");
      assert.equal(child.thread.worktreePath, worktreePath);
      assert.equal(child.thread.lineage.parentThreadId, launched.threadId);
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      // Follow-ups get their own binding after the original task publishes a result.
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:launch:temp-branch:task-result"),
            type: "subagent.updated",
            threadId: launched.threadId,
            runId: run.id,
            occurredAt: now,
            payload: {
              ...delegated.subagents[0]!,
              status: "completed",
              result: "Initial task finished",
              completedAt: now,
              updatedAt: now,
            },
          },
        ],
      });
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:launch:temp-branch:follow-up"),
        threadId: childThreadId,
        senderThreadId: launched.threadId,
        messageId: MessageId.make("message:launch:temp-branch:follow-up"),
        text: "Check the shared checkout again",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "mcp",
      });
      const followUp = (yield* threads.getThreadProjection(childThreadId)).runs.at(-1)!;
      assert.isDefined(followUp.delegatedTaskId);
      assert.equal(followUp.status, "queued");

      const otherThreadId = ThreadId.make("thread:launch:other-branch");
      const otherPathThreadId = ThreadId.make("thread:launch:other-worktree");
      for (const [threadId, branch, otherWorktreePath] of [
        [otherThreadId, "other-feature", worktreePath],
        [otherPathThreadId, "t3/abcd1234", "/repo-worktrees/other"],
      ] as const) {
        yield* threads.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`command:create:${threadId}`),
          threadId,
          projectId,
          title: "Unrelated thread",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch,
          worktreePath: otherWorktreePath,
          createdBy: "user",
          creationSource: "web",
        });
      }
      if (archived) {
        for (const threadId of [childThreadId, otherThreadId, otherPathThreadId]) {
          yield* threads.dispatch({
            type: "thread.archive",
            commandId: CommandId.make(`command:archive:${threadId}`),
            threadId,
          });
        }
      }
      const childBeforeRename = yield* threads.getThreadProjection(childThreadId);
      const tasksBeforeRename = (yield* threads.getThreadProjection(launched.threadId)).subagents;
      const unrelatedBeforeRename = yield* threads.getThreadProjection(otherThreadId);
      const otherPathBeforeRename = yield* threads.getThreadProjection(otherPathThreadId);
      if (parentMoved) {
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("command:launch:parent-moved"),
          threadId: launched.threadId,
          branch: "user/checkout",
          worktreePath: movedPath,
        });
      }
      // Another checkout's history must never be hydrated to propagate a branch rename.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_remove(payload_json, '$.modelSelection')
        WHERE thread_id = ${otherPathThreadId}`;
      yield* Deferred.succeed(allowBranchName, undefined);
      yield* Fiber.await(renameFiber);
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.modelSelection', json(${JSON.stringify(modelSelection)}))
        WHERE thread_id = ${otherPathThreadId}`;
      assert.equal(yield* git.resolveBranchName(worktreePath, "HEAD"), "generated-branch");
      assert.equal(
        (yield* threads.getThreadProjection(launched.threadId)).thread.branch,
        parentMoved ? "user/checkout" : "generated-branch",
      );
      assert.equal(
        (yield* threads.getThreadProjection(launched.threadId)).thread.worktreePath,
        parentMoved ? movedPath : worktreePath,
      );
      assert.equal(
        (yield* threads.getThreadProjection(childThreadId)).thread.branch,
        "generated-branch",
      );
      assert.deepEqual(
        (yield* threads.getThreadProjection(childThreadId)).runs,
        childBeforeRename.runs,
      );
      assert.deepEqual(
        (yield* threads.getThreadProjection(launched.threadId)).subagents.map((task) => [
          task.id,
          task.runId,
          task.parentNodeId,
          task.childThreadId,
        ]),
        tasksBeforeRename.map((task) => [
          task.id,
          task.runId,
          task.parentNodeId,
          task.childThreadId,
        ]),
      );
      assert.equal(
        (yield* threads.getThreadProjection(launched.threadId)).subagents.find(
          (task) => task.id === delegated.subagents[0]!.id,
        )?.result,
        "Initial task finished",
      );
      assert.deepEqual(
        (yield* threads.getThreadProjection(otherThreadId)).thread,
        unrelatedBeforeRename.thread,
      );
      assert.deepEqual(
        (yield* threads.getThreadProjection(otherPathThreadId)).thread,
        otherPathBeforeRename.thread,
      );
      const staleUpdate = yield* threads
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("command:launch:stale-branch-update"),
          threadId: otherThreadId,
          branch: "generated-branch",
          expectedBranch: "t3/abcd1234",
          expectedWorktreePath: worktreePath,
        })
        .pipe(Effect.flip);
      assert.equal(staleUpdate._tag, "OrchestratorDispatchError");
      assert.deepEqual(
        (yield* threads.getThreadProjection(otherThreadId)).thread,
        unrelatedBeforeRename.thread,
      );
      assert.deepEqual(harness.renameBranch.mock.calls[0]?.[0], {
        cwd: worktreePath,
        oldBranch: "t3/abcd1234",
        newBranch: "generated-branch",
      });
    }).pipe(Effect.provide(harness.layer));
  }).pipe(
    Effect.provide(
      GitVcsDriver.layer.pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "launch-git-" })),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("provisions under t3-<hash> when a plain t3 branch blocks t3/*", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      hasCommit: (input) => Effect.succeed(input.refName === "refs/heads/t3"),
      createWorktree: (input) =>
        Effect.succeed({
          worktree: { path: "/repo-worktrees/temp", refName: input.newRefName, headSha: "abc" },
        } as never),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const launched = yield* launches.launch(
        launchInput({
          command: "command:launch:blocked-namespace",
          thread: "thread:launch:blocked-namespace",
          message: "Build the feature",
          workspace: { type: "worktree", baseRef: "main", branch: "t3/abcd1234" },
        }),
      );
      yield* waitUntil(() =>
        threads
          .getThreadProjection(launched.threadId)
          .pipe(Effect.map((projection) => projection.thread.branch === "generated-branch")),
      );
      assert.equal(harness.createWorktree.mock.calls[0]?.[0]?.newRefName, "t3-abcd1234");
      assert.equal(harness.renameBranch.mock.calls[0]?.[0]?.oldBranch, "t3-abcd1234");
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("keeps an explicit branch name instead of generating one", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      yield* launches.launch(
        launchInput({
          command: "command:launch:explicit-branch",
          thread: "thread:launch:explicit-branch",
          message: "Build the feature",
          workspace: { type: "worktree", baseRef: "main", branch: "my-feature" },
        }),
      );
      yield* waitUntil(() => Effect.sync(() => harness.createWorktree.mock.calls.length === 1));
      assert.equal(harness.generateBranchName.mock.calls.length, 0);
      assert.equal(harness.createWorktree.mock.calls[0]?.[0]?.newRefName, "my-feature");
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("keeps the temporary branch when branch generation fails", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      createWorktree: (input) =>
        Effect.succeed({
          worktree: { path: "/repo-worktrees/temp", refName: input.newRefName, headSha: "abc" },
        } as never),
      generateBranchName: () => Effect.die("branch generation is down"),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const launched = yield* launches.launch(
        launchInput({
          command: "command:launch:branch-fallback",
          thread: "thread:launch:branch-fallback",
          message: "Build the feature",
          workspace: { type: "worktree", baseRef: "main", branch: "t3/abcd1234" },
        }),
      );
      yield* waitUntil(() => Effect.sync(() => harness.generateBranchName.mock.calls.length === 1));
      assert.equal(harness.createWorktree.mock.calls[0]?.[0]?.newRefName, "t3/abcd1234");
      yield* waitUntil(() =>
        threads
          .getThreadProjection(launched.threadId)
          .pipe(Effect.map((projection) => projection.runs[0]?.status === "starting")),
      );
      assert.equal(harness.renameBranch.mock.calls.length, 0);
      assert.equal(
        (yield* threads.getThreadProjection(launched.threadId)).thread.branch,
        "t3/abcd1234",
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("renames a temporary branch on an existing worktree to a generated name", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const launched = yield* launches.launch(
        launchInput({
          command: "command:launch:existing-worktree-rename",
          thread: "thread:launch:existing-worktree-rename",
          message: "Build the feature",
          workspace: {
            type: "existing_worktree",
            worktreePath: "/repo-worktrees/t3-abcd1234",
            branch: "t3/abcd1234",
          },
        }),
      );
      yield* waitUntil(() =>
        threads
          .getThreadProjection(launched.threadId)
          .pipe(Effect.map((projection) => projection.thread.branch === "generated-branch")),
      );
      assert.deepEqual(harness.renameBranch.mock.calls[0]?.[0], {
        cwd: "/repo-worktrees/t3-abcd1234",
        oldBranch: "t3/abcd1234",
        newBranch: "generated-branch",
      });
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("shows the fetch diagnosis when preparing a worktree from origin fails", () => {
  const detail =
    "Git could not authenticate with the remote. Check Git credentials or SSH access on the server, then retry.";
  const harness = makeHarness({
    fetchRemote: () =>
      Effect.fail(
        new GitCommandError({
          operation: "GitVcsDriver.fetchRemote",
          command: "git",
          cwd: project.workspaceRoot,
          detail,
          exitCode: 128,
        }),
      ),
  });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch(
      launchInput({
        command: "command:launch:fetch-failure",
        thread: "thread:launch:fetch-failure",
        message: "Start from origin",
        workspace: { type: "worktree", baseRef: "main", startFromOrigin: true },
      }),
    );
    yield* threads.streamStoredEventsFrom({ threadId: launched.threadId }).pipe(
      Stream.filter(
        (stored) => stored.event.type === "run.updated" && stored.event.payload.status === "failed",
      ),
      Stream.runHead,
    );
    const projection = yield* threads.getThreadProjection(launched.threadId);
    assert.equal(projection.messages[0]?.text, "Start from origin");
    assert.equal(projection.runs[0]?.status, "failed");
    assert.equal(projection.thread.worktreePath, null);
    assert.equal(
      projection.turnItems.find((item) => item.type === "command_execution")?.status,
      "failed",
    );
    assert.include(
      projection.turnItems.find((item) => item.type === "error")?.failure.message ?? "",
      detail,
    );
    assert.equal(harness.createWorktree.mock.calls.length, 0);
    assert.equal(harness.runSetup.mock.calls.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("retries a failed workspace preparation on the same run", () => {
  let fetchFailures = 1;
  const harness = makeHarness({
    fetchRemote: () =>
      fetchFailures-- > 0
        ? Effect.fail(
            new GitCommandError({
              operation: "GitVcsDriver.fetchRemote",
              command: "git",
              cwd: project.workspaceRoot,
              detail: "Git could not update a local reference.",
              exitCode: 1,
            }),
          )
        : Effect.void,
  });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch(
      launchInput({
        command: "command:launch:retry",
        thread: "thread:launch:retry",
        message: "Retry me",
        workspace: { type: "worktree", baseRef: "main", startFromOrigin: true },
      }),
    );
    yield* waitUntil(() =>
      threads
        .getThreadProjection(launched.threadId)
        .pipe(Effect.map((projection) => projection.runs[0]?.status === "failed")),
    );
    const failed = yield* threads.getThreadProjection(launched.threadId);
    const runId = failed.runs[0]!.id;
    assert.equal(
      failed.turnItems.find((item) => item.type === "error")?.failure.code,
      ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
    );

    const retry = {
      commandId: CommandId.make("command:launch:retry:1"),
      threadId: launched.threadId,
      runId,
    };
    yield* launches.retryPreparation(retry);
    yield* waitUntil(() =>
      outbox
        .listByCommandId(CommandId.make("command:launch:retry:1:release"))
        .pipe(Effect.map((effects) => effects.length === 1)),
    );
    const retried = yield* threads.getThreadProjection(launched.threadId);
    assert.equal(retried.runs.length, 1);
    assert.equal(retried.runs[0]?.status, "starting");
    assert.equal(retried.thread.worktreePath, "/repo-worktrees/feature");
    assert.equal(retried.turnItems.find((item) => item.type === "error")?.status, "cancelled");
    assert.equal(
      retried.turnItems.find((item) => item.type === "command_execution")?.status,
      "completed",
    );
    assert.equal(harness.createWorktree.mock.calls.length, 1);

    // The run left preparation, so a second retry has nothing to do.
    const rejected = yield* launches
      .retryPreparation({ ...retry, commandId: CommandId.make("command:launch:retry:2") })
      .pipe(Effect.flip);
    assert.equal(rejected._tag, "OrchestratorDispatchError");
  }).pipe(Effect.provide(harness.layer));
});

it.effect.each(["fails", "is interrupted"] as const)(
  "holds a message queued during setup when the workspace preparation %s",
  (ending) =>
    Effect.gen(function* () {
      const fetchEntered = yield* Deferred.make<void>();
      const allowFetch = yield* Deferred.make<void>();
      let fetchFailures = 1;
      const harness = makeHarness({
        fetchRemote: () =>
          fetchFailures-- <= 0
            ? Effect.void
            : Deferred.succeed(fetchEntered, undefined).pipe(
                Effect.andThen(Deferred.await(allowFetch)),
                Effect.andThen(
                  Effect.fail(
                    new GitCommandError({
                      operation: "GitVcsDriver.fetchRemote",
                      command: "git",
                      cwd: project.workspaceRoot,
                      detail: "Git could not reach the remote.",
                      exitCode: 128,
                    }),
                  ),
                ),
              ),
      });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const launched = yield* launches.launch(
          launchInput({
            command: `command:launch:queued-setup-${ending}`,
            thread: `thread:launch:queued-setup-${ending}`,
            message: "First message",
            workspace: { type: "worktree", baseRef: "main", startFromOrigin: true },
          }),
        );
        yield* Deferred.await(fetchEntered);
        const queued = yield* threads.sendToThread({
          projectId,
          commandId: CommandId.make(`command:launch:queued-setup-${ending}:follow-up`),
          threadId: launched.threadId,
          messageId: MessageId.make(`message:launch:queued-setup-${ending}:follow-up`),
          text: "Sent during setup",
          attachments: [],
          mode: "queue",
          createdBy: "user",
          creationSource: "web",
        });
        assert.equal(queued.delivery, "queued");
        if (ending === "fails") {
          yield* Deferred.succeed(allowFetch, undefined);
        } else {
          // An agent stop does not ask to hold the queue.
          yield* threads.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("command:launch:queued-setup-interrupt"),
            threadId: launched.threadId,
            runId: launched.projection.runs[0]!.id,
          });
        }

        // Without its worktree the follow-up would start in the project checkout.
        yield* threads.streamStoredEventsFrom({ threadId: launched.threadId }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" && stored.event.payload.queueHeld === true,
          ),
          Stream.runHead,
        );
        const projection = yield* threads.getThreadProjection(launched.threadId);
        assert.equal(projection.runs.at(-1)?.status, "queued");
        assert.equal(projection.thread.worktreePath, null);

        if (ending === "fails") {
          // A successful retry lets the held message follow the first turn again.
          yield* launches.retryPreparation({
            commandId: CommandId.make("command:launch:queued-setup-retry"),
            threadId: launched.threadId,
            runId: launched.projection.runs[0]!.id,
          });
          const retried = yield* threads.getThreadProjection(launched.threadId);
          assert.equal(retried.runs.at(-1)?.queueHeld, false);
        }
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect.each(["failed", "interrupted"] as const)(
  "holds a message queued during setup that arrives after the setup %s",
  (ending) => {
    let fetchEntered: Deferred.Deferred<void> | null = null;
    const harness = makeHarness({
      fetchRemote: () =>
        ending === "interrupted"
          ? Deferred.succeed(fetchEntered!, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.fail(
              new GitCommandError({
                operation: "GitVcsDriver.fetchRemote",
                command: "git",
                cwd: project.workspaceRoot,
                detail: "Git could not reach the remote.",
                exitCode: 128,
              }),
            ),
    });
    return Effect.gen(function* () {
      fetchEntered = yield* Deferred.make<void>();
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const launched = yield* launches.launch(
        launchInput({
          command: `command:launch:late-queued-follow-up-${ending}`,
          thread: `thread:launch:late-queued-follow-up-${ending}`,
          message: "First message",
          workspace: { type: "worktree", baseRef: "main", startFromOrigin: true },
        }),
      );
      if (ending === "interrupted") {
        yield* Deferred.await(fetchEntered);
        // An agent stop does not ask to hold the queue.
        yield* threads.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("command:launch:late-queued-follow-up:interrupt"),
          threadId: launched.threadId,
          runId: launched.projection.runs[0]!.id,
        });
      }
      yield* threads.streamStoredEventsFrom({ threadId: launched.threadId }).pipe(
        Stream.filter(
          (stored) => stored.event.type === "run.updated" && stored.event.payload.status === ending,
        ),
        Stream.runHead,
      );

      // Queued while setup ran, delivered only after it failed: it must not start
      // in the project checkout.
      const queued = yield* threads.sendToThread({
        projectId,
        commandId: CommandId.make(`command:launch:late-queued-follow-up-${ending}:send`),
        threadId: launched.threadId,
        messageId: MessageId.make(`message:launch:late-queued-follow-up-${ending}:send`),
        text: "Sent during setup",
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "web",
      });
      assert.equal(queued.delivery, "queued");
      const projection = yield* threads.getThreadProjection(launched.threadId);
      const held = projection.runs.at(-1)!;
      assert.equal(held.status, "queued");
      assert.equal(held.queueHeld, true);

      // A message the user starts does not release it: the held message would
      // run after it in the project checkout.
      yield* threads.sendToThread({
        projectId,
        commandId: CommandId.make(`command:launch:late-queued-follow-up-${ending}:start`),
        threadId: launched.threadId,
        messageId: MessageId.make(`message:launch:late-queued-follow-up-${ending}:start`),
        text: "Sent after setup",
        attachments: [],
        mode: "auto",
        createdBy: "user",
        creationSource: "web",
      });
      // Nor does the next one, though the run that message started is now the
      // latest and carries no workspace preparation.
      yield* threads.sendToThread({
        projectId,
        commandId: CommandId.make(`command:launch:late-queued-follow-up-${ending}:again`),
        threadId: launched.threadId,
        messageId: MessageId.make(`message:launch:late-queued-follow-up-${ending}:again`),
        text: "Sent after that",
        attachments: [],
        mode: "auto",
        createdBy: "user",
        creationSource: "web",
      });
      const after = yield* threads.getThreadProjection(launched.threadId);
      assert.isTrue(after.runs.find((run) => run.id === held.id)?.queueHeld);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("a retry reuses a recorded worktree without undoing its branch rename", () => {
  let setupFailures = 1;
  const harness = makeHarness({
    runSetup: () =>
      setupFailures-- > 0
        ? Effect.fail(new Error("setup failed") as never)
        : Effect.succeed({ status: "no-script" as const }),
  });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
    const launched = yield* launches.launch(
      launchInput({
        command: "command:launch:reuse",
        thread: "thread:launch:reuse",
        message: "Reuse the worktree",
        workspace: { type: "worktree", baseRef: "main" },
      }),
    );
    yield* waitUntil(() =>
      threads
        .getThreadProjection(launched.threadId)
        .pipe(
          Effect.map(
            (projection) =>
              projection.runs[0]?.status === "failed" &&
              projection.thread.branch === "generated-branch",
          ),
        ),
    );
    const failed = yield* threads.getThreadProjection(launched.threadId);
    assert.equal(failed.thread.worktreePath, "/repo-worktrees/feature");

    yield* launches.retryPreparation({
      commandId: CommandId.make("command:launch:reuse:retry"),
      threadId: launched.threadId,
      runId: failed.runs[0]!.id,
    });
    yield* waitUntil(() =>
      outbox
        .listByCommandId(CommandId.make("command:launch:reuse:retry:release"))
        .pipe(Effect.map((effects) => effects.length === 1)),
    );
    const retried = yield* threads.getThreadProjection(launched.threadId);
    assert.equal(retried.runs[0]?.status, "starting");
    // The retry neither checks out again nor puts back the temporary branch.
    assert.equal(harness.createWorktree.mock.calls.length, 1);
    assert.equal(harness.renameBranch.mock.calls.length, 1);
    assert.equal(retried.thread.branch, "generated-branch");
    assert.equal(retried.thread.worktreePath, "/repo-worktrees/feature");
    // Clients see the retry's setup, not the failed one it replaced. The setup
    // finishes after the release commits, so wait for it.
    yield* waitUntil(() =>
      tracker.get(launched.threadId).pipe(Effect.map((setup) => setup?.phase !== "running")),
    );
    const snapshot = yield* tracker.get(launched.threadId);
    assert.equal(snapshot?.phase, "done");
    assert.deepEqual(
      snapshot?.stages.map((stage) => stage.id),
      ["setup-script", "agent"],
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("removes a worktree that failed before the thread recorded it", () => {
  const harness = makeHarness({
    // A checkout that dies after claiming its directory.
    createWorktree: (_input, options) =>
      (options?.progress?.onWorktreeClaimed?.("/repo-worktrees/partial") ?? Effect.void).pipe(
        Effect.andThen(Effect.fail(new Error("checkout failed") as never)),
      ),
  });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch(
      launchInput({
        command: "command:launch:partial-worktree",
        thread: "thread:launch:partial-worktree",
        message: "Partial checkout",
        workspace: { type: "worktree", baseRef: "main" },
      }),
    );
    yield* waitUntil(() =>
      threads
        .getThreadProjection(launched.threadId)
        .pipe(Effect.map((projection) => projection.runs[0]?.status === "failed")),
    );
    const projection = yield* threads.getThreadProjection(launched.threadId);
    // Unrecorded, so a retry would create a second checkout beside it.
    assert.equal(projection.thread.worktreePath, null);
    assert.deepEqual(
      harness.removeWorktree.mock.calls.map(([input]) => input.path),
      ["/repo-worktrees/partial"],
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect.each(["worktree", "setup"] as const)(
  "%s failure keeps the thread and message visible and emits failure items",
  (failurePoint) =>
    Effect.gen(function* () {
      const failure = new Error(`${failurePoint} failed`);
      const harness = makeHarness(
        failurePoint === "worktree"
          ? { createWorktree: () => Effect.fail(failure as never) }
          : { runSetup: () => Effect.fail(failure as never) },
      );
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const input = launchInput({
          command: `command:launch:${failurePoint}-failure`,
          thread: `thread:launch:${failurePoint}-failure`,
          message: `Fail during ${failurePoint}`,
          workspace: { type: "worktree", baseRef: "main" },
        });
        const launched = yield* launches.launch(input);
        yield* waitUntil(() =>
          threads
            .getThreadProjection(launched.threadId)
            .pipe(Effect.map((projection) => projection.runs[0]?.status === "failed")),
        );
        const projection = yield* threads.getThreadProjection(launched.threadId);
        assert.equal(projection.messages[0]?.text, `Fail during ${failurePoint}`);
        assert.equal(projection.runs[0]?.status, "failed");
        assert.equal(
          projection.turnItems.find((item) => item.type === "command_execution")?.status,
          "failed",
        );
        assert.match(
          projection.turnItems.find((item) => item.type === "error")?.failure.message ?? "",
          new RegExp(`${failurePoint} failed`, "u"),
        );
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect("replays a server-allocated launch", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const { threadId: _unusedThreadId, ...rest } = launchInput({
        command: "command:launch:allocated-retry",
        thread: "unused",
        message: "Only once",
      });
      const first = yield* launches.launch(rest);
      yield* Deferred.await(setupEntered);
      const retry = yield* launches.launch(rest);
      assert.equal(first.threadId, retry.threadId);
      assert.isFalse(first.resumed);
      assert.isTrue(retry.resumed);
      assert.equal(harness.runSetup.mock.calls.length, 1);
      assert.equal(retry.projection.messages.length, 1);
      assert.equal(retry.projection.runs.length, 1);
      assert.equal(retry.projection.messages[0]?.id, first.projection.messages[0]?.id);
      assert.equal(retry.projection.runs[0]?.id, first.projection.runs[0]?.id);
      yield* Deferred.succeed(allowSetup, undefined);
      yield* threads.streamStoredEventsFrom({ threadId: first.threadId }).pipe(
        Stream.filter(
          (stored) =>
            stored.commandId === CommandId.make(`${rest.commandId}:release`) &&
            stored.event.type === "run.updated",
        ),
        Stream.runHead,
      );
      const settled = yield* launches.launch(rest);
      assert.equal(settled.threadId, first.threadId);
      assert.isTrue(settled.resumed);
      assert.equal(settled.projection.messages[0]?.id, first.projection.messages[0]?.id);
      assert.equal(settled.projection.runs[0]?.id, first.projection.runs[0]?.id);
      assert.equal(harness.runSetup.mock.calls.length, 1);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("refuses a launch when the project disables the model's provider instance", () => {
  const harness = makeHarness({
    serverSettings: {
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [modelSelection.instanceId]: { enabled: false } } },
      },
    },
  });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const failed = yield* launches
      .launch(
        launchInput({
          command: "command:launch:project-disabled-instance",
          thread: "thread:launch:project-disabled-instance",
          message: "Hello",
        }),
      )
      .pipe(Effect.flip);
    if (failed._tag !== "ThreadManagementProviderInstanceDisabledError") {
      assert.fail(`expected ThreadManagementProviderInstanceDisabledError, got ${failed._tag}`);
    }
    assert.equal(failed.projectId, projectId);
    assert.equal(failed.instanceId, modelSelection.instanceId);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("replays an accepted launch after the project disables the instance", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const input = launchInput({
      command: "command:launch:retry-after-disable",
      thread: "thread:launch:retry-after-disable",
      message: "Hello",
    });
    const first = yield* launches.launch(input);

    yield* settings.updateSettings({
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [modelSelection.instanceId]: { enabled: false } } },
      },
    });

    const retry = yield* launches.launch(input);
    assert.equal(retry.threadId, first.threadId);
    assert.isTrue(retry.resumed);

    const fresh = yield* launches
      .launch(
        launchInput({
          command: "command:launch:fresh-after-disable",
          thread: "thread:launch:fresh-after-disable",
          message: "Hello",
        }),
      )
      .pipe(Effect.flip);
    if (fresh._tag !== "ThreadManagementProviderInstanceDisabledError") {
      assert.fail(`expected ThreadManagementProviderInstanceDisabledError, got ${fresh._tag}`);
    }
  }).pipe(Effect.provide(harness.layer));
});

it.effect("rejects a server-allocated launch replay with a mismatching thread id", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const { threadId: _unusedThreadId, ...rest } = launchInput({
      command: "command:launch:allocated-mismatch",
      thread: "unused",
      message: "Mismatch",
    });
    const first = yield* launches.launch(rest);
    const failed = yield* launches
      .launch({
        ...rest,
        threadId: ThreadId.make("thread:launch:allocated-mismatch"),
      })
      .pipe(Effect.flip);
    assert.notEqual(first.threadId, ThreadId.make("thread:launch:allocated-mismatch"));
    if (failed._tag !== "ThreadLaunchError") {
      assert.fail(`expected ThreadLaunchError, got ${failed._tag}`);
    }
    assert.equal(failed.operation, "create-thread");
    assert.include(String(failed.cause), "cannot be replayed");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("rejects a server-allocated launch receipt from another project", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const { threadId: _unusedThreadId, ...rest } = launchInput({
      command: "command:launch:allocated-wrong-project",
      thread: "unused",
      message: "Wrong project",
    });
    const first = yield* launches.launch(rest);
    const failed = yield* launches
      .launch({
        ...rest,
        projectId: otherProjectId,
      })
      .pipe(Effect.flip);
    if (failed._tag !== "ThreadLaunchError") {
      assert.fail(`expected ThreadLaunchError, got ${failed._tag}`);
    }
    assert.equal(failed.operation, "resolve-project");
    assert.equal(failed.threadId, first.threadId);
    assert.equal(failed.cause, "Project identity changed.");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("rejects a server-allocated launch retry after the thread is deleted", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const { threadId: _unusedThreadId, ...rest } = launchInput({
      command: "command:launch:allocated-deleted",
      thread: "unused",
      message: "Deleted before retry",
    });
    const first = yield* launches.launch(rest);
    yield* threads.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("command:launch:allocated-deleted:delete"),
      threadId: first.threadId,
    });
    const failed = yield* launches.launch(rest).pipe(Effect.flip);
    if (failed._tag !== "ThreadLaunchError") {
      assert.fail(`expected ThreadLaunchError, got ${failed._tag}`);
    }
    assert.equal(failed.operation, "create-thread");
    assert.equal(failed.threadId, first.threadId);
    assert.equal(failed.cause, "Thread not found.");
    const shells = yield* threads.listProjectThreads({ projectId, includeSubagents: true });
    assert.equal(shells.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("does not treat an unrelated accepted command receipt as a launch", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = ThreadId.make("thread:launch:unrelated-receipt");
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make("command:launch:unrelated-receipt:create"),
      threadId,
      projectId,
      title: "Existing",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* threads.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("command:launch:unrelated-receipt"),
      threadId,
      expectedEmpty: true,
    });
    const { threadId: _unusedThreadId, ...rest } = launchInput({
      command: "command:launch:unrelated-receipt",
      thread: "unused",
      message: "Should not become a launch",
    });
    const failed = yield* launches.launch(rest).pipe(Effect.flip);
    if (failed._tag !== "ThreadLaunchError") {
      assert.fail(`expected ThreadLaunchError, got ${failed._tag}`);
    }
    assert.equal(failed.operation, "create-thread");
    assert.include(String(failed.cause), "cannot be replayed");
    const projection = yield* threads.getThreadProjection(threadId);
    assert.equal(projection.messages.length, 0);
    assert.equal(projection.runs.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("bounds concurrent first launches to one thread per command", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const { threadId: _unusedThreadId, ...rest } = launchInput({
        command: "command:launch:concurrent-allocated",
        thread: "unused",
        message: "Race me",
      });
      // The command receipt is reserved atomically with the winning create, so
      // a loser either replays the winner's stored events or surfaces a
      // transient replay conflict that the next attempt resolves — the race
      // can never persist a second thread.
      const results = yield* Effect.all(
        [launches.launch(rest).pipe(Effect.exit), launches.launch(rest).pipe(Effect.exit)],
        { concurrency: "unbounded" },
      );
      const winner = results.find(Exit.isSuccess);
      assert.isDefined(winner);
      const threadId = winner!.value.threadId;
      for (const result of results) {
        if (Exit.isSuccess(result)) {
          assert.equal(result.value.threadId, threadId);
          continue;
        }
        const error = Cause.findErrorOption(result.cause).pipe(Option.getOrThrow);
        if (error._tag !== "ThreadLaunchError") {
          assert.fail(`expected ThreadLaunchError, got ${error._tag}`);
        }
        assert.equal(error.operation, "create-thread");
        assert.include(String(error.cause), "cannot be replayed");
        const retried = yield* launches.launch(rest);
        assert.equal(retried.threadId, threadId);
      }
      const projectThreads = yield* threads.listProjectThreads({
        projectId,
        includeSubagents: false,
      });
      assert.equal(projectThreads.length, 1);
      const projection = yield* threads.getThreadProjection(threadId);
      assert.equal(projection.messages.length, 1);
      assert.equal(projection.runs.length, 1);
      yield* Deferred.await(setupEntered);
      assert.equal(harness.runSetup.mock.calls.length, 1);
      yield* Deferred.succeed(allowSetup, undefined);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("deduplicates retried launch side effects in-process", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const input = launchInput({
        command: "command:launch:retry",
        thread: "thread:launch:retry",
        message: "Only once",
      });
      const [first, retry] = yield* Effect.all([launches.launch(input), launches.launch(input)], {
        concurrency: "unbounded",
      });
      yield* Deferred.await(setupEntered);
      assert.equal(first.threadId, retry.threadId);
      assert.isFalse(first.resumed);
      assert.isTrue(retry.resumed);
      assert.equal(harness.runSetup.mock.calls.length, 1);
      yield* Deferred.succeed(allowSetup, undefined);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("does not let a failing same-command caller strand a concurrent durable launch", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const command = "command:launch:failed-owner-race";
      const [failed, launched] = yield* Effect.all(
        [
          launches
            .launch({
              ...launchInput({
                command,
                thread: "thread:launch:failed-owner-race",
                message: "This invalid reuse fails",
              }),
              reuseExistingThread: true,
            })
            .pipe(Effect.exit),
          launches.launch(
            launchInput({
              command,
              thread: "thread:launch:successful-peer",
              message: "This peer persists",
            }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      assert.isTrue(Exit.isFailure(failed));
      assert.equal(launched.projection.runs[0]?.status, "preparing");
      const entered = yield* Deferred.await(setupEntered).pipe(
        Effect.timeoutOption(Duration.seconds(2)),
      );
      assert.isTrue(Option.isSome(entered));
      assert.equal(harness.runSetup.mock.calls.length, 1);
      yield* Deferred.succeed(allowSetup, undefined);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("schedules an accepted preparing message exactly once across concurrent retries", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const input = launchInput({
        command: "command:launch:accepted-before-fork",
        thread: "thread:launch:accepted-before-fork",
        message: "Resume preparation",
      });
      const messageId = MessageId.make("message:launch:accepted-before-fork");

      yield* threads.dispatch({
        type: "thread.create",
        commandId: input.commandId,
        threadId: input.threadId,
        projectId: input.projectId,
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        branch: null,
        worktreePath: null,
        createdBy: input.createdBy,
        creationSource: input.creationSource,
      });
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`${input.commandId}:initial-message`),
        threadId: input.threadId,
        messageId,
        text: "Resume preparation",
        attachments: [],
        modelSelection: input.modelSelection,
        dispatchMode: { type: "defer_start" },
        createdBy: input.createdBy,
        creationSource: input.creationSource,
      });
      const preparing = yield* threads.getThreadProjection(input.threadId);
      assert.equal(preparing.runs[0]?.status, "preparing");

      const [first, second] = yield* Effect.all([launches.launch(input), launches.launch(input)], {
        concurrency: "unbounded",
      });
      yield* Deferred.await(setupEntered);
      assert.isTrue(first.resumed);
      assert.isTrue(second.resumed);
      assert.equal(harness.runSetup.mock.calls.length, 1);
      yield* Deferred.succeed(allowSetup, undefined);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("creates a strong provider-thread mapping for an imported native session", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const input = {
      ...launchInput({
        command: "command:launch:imported-native-session",
        thread: "thread:launch:imported-native-session",
      }),
      importedNativeThread: {
        ref: {
          driver: ProviderDriverKind.make("codex"),
          nativeId: "native-session-42",
          strength: "strong" as const,
        },
        metadata: {
          title: "Native session",
          updatedAt: "2026-08-23T00:00:00Z",
        },
      },
    };

    const launched = yield* launches.launch(input);

    assert.deepInclude(launched.projection.providerThreads[0], {
      id: IdAllocator.deriveProviderThread({
        driver: input.importedNativeThread.ref.driver,
        providerInstanceId: modelSelection.instanceId,
        nativeThreadId: input.importedNativeThread.ref.nativeId,
      }),
      driver: input.importedNativeThread.ref.driver,
      providerInstanceId: modelSelection.instanceId,
      appThreadId: input.threadId,
      nativeThreadRef: input.importedNativeThread.ref,
      status: "not_loaded",
      nativeMetadata: input.importedNativeThread.metadata,
    });
    assert.equal(
      launched.projection.thread.activeProviderThreadId,
      launched.projection.providerThreads[0]?.id,
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("shared intake preserves durable attachment bytes after a lost launch result", () => {
  let projectAvailable = true;
  const harness = makeHarness({ projectAvailable: () => projectAvailable });
  const layerFiles = ServerConfig.layerTest(process.cwd(), { prefix: "t3-message-intake-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  );
  return Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const pendingId = createPendingAttachmentId();
    assert.isNotNull(pendingId);
    const attachment: ChatAttachment = {
      type: "image",
      id: ChatAttachmentId.make(pendingId),
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };
    const pendingPath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment,
    });
    assert.isNotNull(pendingPath);
    yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
    yield* fs.writeFile(pendingPath, new Uint8Array([1, 2, 3, 4]));
    const input = {
      ...launchInput({ command: "intake-launch", thread: "intake-thread" }),
      initialMessage: {
        messageId: MessageId.make("intake-first"),
        text: "First [file](t3-context://v1/file/intake-file)",
        context: {
          version: 1 as const,
          records: [
            {
              version: 1 as const,
              contextId: ComposerContextId.make("intake-file"),
              kind: "file" as const,
              label: attachment.name,
              attachmentId: attachment.id,
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
            },
          ],
        },
        attachments: [attachment],
      },
    };
    const failed = yield* ThreadMessageIntake.launchThread(input).pipe(
      Effect.provideService(ThreadLaunch.ThreadLaunchService, {
        launch: (request) =>
          launches.launch(request).pipe(
            Effect.andThen(
              new ThreadLaunch.ThreadLaunchError({
                operation: "create-thread",
                commandId: request.commandId,
                projectId,
                cause: "lost result after acceptance",
              }),
            ),
          ),
        checkWorktreeBase: launches.checkWorktreeBase,
        isNonGitProject: launches.isNonGitProject,
        retryPreparation: launches.retryPreparation,
        prepareRun: launches.prepareRun,
        startUserSubagent: launches.startUserSubagent,
      }),
      Effect.flip,
    );
    assert.equal(failed._tag, "ThreadLaunchError");
    assert.ok(
      failed._tag === "ThreadLaunchError" &&
        !ThreadMessageIntake.launchMessageWasNotAccepted(failed),
    );
    // The observer failed, but the real V2 message and its bytes were accepted.
    const accepted = yield* threads.getThreadProjection(input.threadId);
    const stored = accepted.messages.find(
      (message) => message.id === input.initialMessage.messageId,
    );
    assert.isDefined(stored);
    assert.notEqual(stored.attachments[0]?.id, attachment.id);
    assert.equal(
      (stored.context?.records[0] as { attachmentId: string }).attachmentId,
      stored.attachments[0]?.id,
    );
    const userItem = accepted.turnItems.find(
      (item) => item.type === "user_message" && item.messageId === stored.id,
    );
    assert.ok(userItem?.type === "user_message");
    assert.deepEqual(userItem.context, stored.context);
    const storedPath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: stored.attachments[0]!,
    });
    assert.isNotNull(storedPath);
    assert.deepEqual(yield* fs.readFile(storedPath), new Uint8Array([1, 2, 3, 4]));
    assert.deepEqual(yield* fs.readFile(pendingPath), new Uint8Array([1, 2, 3, 4]));

    // With staging still present, count copies as well: a redundant copy followed
    // by cleanup would leave the directory looking identical.
    const replayCopy = vi.fn(fs.copyFile);
    const replayFiles = { ...fs, copyFile: replayCopy };
    const replayed = yield* ThreadMessageIntake.launchThread(input).pipe(
      Effect.provideService(FileSystem.FileSystem, replayFiles),
    );
    assert.equal(replayCopy.mock.calls.length, 0);
    assert.equal(replayed.projection.messages[0]?.id, stored.id);
    assert.deepEqual(replayed.projection.messages[0]?.attachments, stored.attachments);
    const claimedFiles = Effect.map(fs.readDirectory(config.attachmentsDir), (files) =>
      files.filter((name) => !name.startsWith("pending-")),
    );
    assert.equal((yield* claimedFiles).length, 1);

    const duplicate = yield* ThreadMessageIntake.launchThread({
      ...input,
      commandId: CommandId.make("intake-duplicate-create"),
      initialMessage: { ...input.initialMessage, messageId: MessageId.make("intake-duplicate") },
    }).pipe(Effect.result);
    assert.ok(Result.isFailure(duplicate));
    assert.ok(duplicate.failure._tag === "ThreadLaunchError");
    assert.equal(duplicate.failure.operation, "create-thread");
    assert.propertyVal(duplicate.failure.cause, "_tag", "OrchestratorThreadAlreadyExistsError");
    assert.equal((yield* claimedFiles).length, 1);
    assert.deepEqual(yield* fs.readFile(storedPath), new Uint8Array([1, 2, 3, 4]));
    assert.deepEqual(yield* fs.readFile(pendingPath), new Uint8Array([1, 2, 3, 4]));

    const missingProject = yield* ThreadMessageIntake.launchThread({
      ...input,
      commandId: CommandId.make("intake-no-project"),
      projectId: ProjectId.make("missing-project"),
    }).pipe(Effect.flip);
    assert.equal(missingProject._tag, "ThreadLaunchError");
    assert.ok(
      missingProject._tag === "ThreadLaunchError" &&
        ThreadMessageIntake.launchMessageWasNotAccepted(missingProject),
    );
    assert.equal((yield* claimedFiles).length, 1);
    const missingThread = yield* ThreadMessageIntake.dispatchCommand({
      type: "message.dispatch",
      commandId: CommandId.make("intake-no-thread"),
      threadId: ThreadId.make("missing-thread"),
      messageId: MessageId.make("intake-missing"),
      text: "Missing",
      attachments: [attachment],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    }).pipe(Effect.flip);
    assert.equal(missingThread._tag, "OrchestratorProjectionError");
    assert.equal((yield* claimedFiles).length, 1);

    // Both ordinary command intake (RPC) and send intake (MCP) use the same store.
    const dispatchInput = {
      type: "message.dispatch",
      commandId: CommandId.make("intake-dispatch"),
      threadId: input.threadId,
      messageId: MessageId.make("intake-second"),
      text: "Second",
      attachments: [attachment],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    } as const;
    const dispatch = ThreadMessageIntake.dispatchCommand(dispatchInput);
    const receipt = yield* dispatch;
    yield* dispatch.pipe(Effect.provideService(FileSystem.FileSystem, replayFiles));
    assert.equal(replayCopy.mock.calls.length, 0);
    const queuedProjection = yield* threads.getThreadProjection(input.threadId);
    const queuedRun = queuedProjection.runs.find(
      (run) => run.userMessageId === MessageId.make("intake-second"),
    );
    assert.isDefined(queuedRun);
    assert.equal(queuedRun.status, "queued");
    const queuedMessage = queuedProjection.messages.find(
      (message) => message.id === queuedRun.userMessageId,
    );
    assert.isDefined(queuedMessage);
    const file: ChatAttachment = {
      type: "file",
      id: ChatAttachmentId.make(createPendingAttachmentId("pdf")),
      name: "queued.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4,
    };
    const filePath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: file,
    });
    assert.isNotNull(filePath);
    yield* fs.writeFile(filePath, new Uint8Array([5, 6, 7, 8]));
    const edit = ThreadMessageIntake.dispatchCommand({
      type: "queued-run.edit",
      commandId: CommandId.make("intake-edit"),
      threadId: input.threadId,
      runId: queuedRun.id,
      text: "Edited with a file",
      attachments: [...queuedMessage.attachments, file],
    });
    yield* edit;
    yield* edit;
    const editedProjection = yield* threads.getThreadProjection(input.threadId);
    const editedMessage = editedProjection.messages.find(
      (message) => message.id === queuedRun.userMessageId,
    );
    assert.isDefined(editedMessage);
    assert.equal(editedMessage.attachments.length, 2);
    assert.deepEqual(editedMessage.attachments[0], queuedMessage.attachments[0]);
    assert.notEqual(editedMessage.attachments[1]?.id, file.id);
    const durableFilePath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: editedMessage.attachments[1]!,
    });
    assert.isNotNull(durableFilePath);
    assert.deepEqual(yield* fs.readFile(durableFilePath), new Uint8Array([5, 6, 7, 8]));
    assert.deepEqual(yield* fs.readFile(filePath), new Uint8Array([5, 6, 7, 8]));
    const beforeRejectedEdit = (yield* claimedFiles).length;
    const rejectedEdit = yield* ThreadMessageIntake.dispatchCommand({
      type: "queued-run.edit",
      commandId: CommandId.make("intake-edit-rejected"),
      threadId: input.threadId,
      runId: queuedRun.id,
      text: "",
      attachments: [file],
    }).pipe(Effect.flip);
    assert.equal(rejectedEdit._tag, "OrchestratorCommandRejectedError");
    assert.equal((yield* claimedFiles).length, beforeRejectedEdit);
    assert.deepEqual(yield* fs.readFile(filePath), new Uint8Array([5, 6, 7, 8]));
    const send = ThreadMessageIntake.sendToThread({
      commandId: CommandId.make("intake-send"),
      projectId,
      threadId: input.threadId,
      messageId: MessageId.make("intake-third"),
      text: "Third",
      attachments: [attachment],
      mode: "queue",
      createdBy: "agent",
      creationSource: "mcp",
    });
    yield* send;
    yield* send;
    assert.equal((yield* claimedFiles).length, 4);
    const final = yield* threads.getThreadProjection(input.threadId);
    assert.equal(final.messages.length, 3);
    for (const message of final.messages) {
      const path = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment: message.attachments[0]!,
      });
      assert.isNotNull(path);
      assert.deepEqual(yield* fs.readFile(path), new Uint8Array([1, 2, 3, 4]));
    }
    // Expire only staging. Both accepted commands still have their receipts and permanent bytes.
    yield* fs.remove(pendingPath);
    assert.equal(yield* threads.hasReceipt(dispatchInput.commandId, { acceptedOnly: true }), true);
    assert.equal((yield* dispatch).sequence, receipt.sequence);
    projectAvailable = false;
    const launchReplay = yield* ThreadMessageIntake.launchThread(input);
    projectAvailable = true;
    assert.equal(launchReplay.resumed, true);
    assert.deepEqual(
      launchReplay.projection.messages.map((row) => row.id),
      final.messages.map((row) => row.id),
    );
    assert.equal((yield* claimedFiles).length, 4);
    for (const conflict of [
      { ...dispatchInput, threadId: ThreadId.make("other-thread") },
      { ...dispatchInput, commandId: input.commandId },
    ]) {
      const failure = yield* ThreadMessageIntake.dispatchCommand(conflict).pipe(Effect.flip);
      assert.equal(failure._tag, "OrchestratorDispatchError");
    }
    const conflictingTextOnly = yield* ThreadMessageIntake.dispatchCommand({
      ...dispatchInput,
      commandId: input.commandId,
      attachments: [],
    }).pipe(Effect.flip);
    assert.equal(conflictingTextOnly._tag, "OrchestratorCommandRejectedError");
    const fresh = yield* ThreadMessageIntake.dispatchCommand({
      ...dispatchInput,
      commandId: CommandId.make("intake-fresh"),
    }).pipe(Effect.flip);
    assert.equal(fresh._tag, "AttachmentClaimError");
    // A create receipt on its own does not prove its initial send committed.
    const partial = {
      ...input,
      commandId: CommandId.make("intake-partial"),
      threadId: ThreadId.make("intake-partial"),
    };
    yield* launches.launch(launchInput({ command: partial.commandId, thread: partial.threadId }));
    const partialRetry = yield* ThreadMessageIntake.launchThread(partial).pipe(Effect.flip);
    assert.equal(partialRetry._tag, "AttachmentClaimError");
  }).pipe(Effect.provide(Layer.mergeAll(harness.layer, layerFiles)));
});

it.effect("cancels tracked setup before provider work is released", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const input = launchInput({
        command: "launch:cancel-tracked",
        thread: "thread:cancel-tracked",
        message: "Start",
        workspace: { type: "worktree", baseRef: "main" },
      });
      const launched = yield* launches.launch(input);
      yield* Deferred.await(entered);
      assert.equal((yield* tracker.get(launched.threadId))?.phase, "running");
      assert.isTrue(yield* tracker.cancel(launched.threadId));
      assert.equal((yield* tracker.get(launched.threadId))?.phase, "cancelled");
      const projection = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(projection.runs[0]?.status, "failed");
      assert.isNull(projection.thread.worktreePath);
      assert.isEmpty(yield* outbox.listByCommandId(CommandId.make(`${input.commandId}:release`)));
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect.each([0, 1])("releases an async setup before its completion with exit %s", (exitCode) =>
  Effect.gen(function* () {
    const completion = yield* Deferred.make<{ exitCode: number | null; durationMs: number }>();
    const harness = makeHarness({
      runSetup: () =>
        Effect.succeed({
          status: "started" as const,
          async: true,
          scriptId: "setup",
          scriptName: "Setup",
          scriptCommand: "vp install",
          terminalId: "setup",
          cwd: "/repo-worktrees/feature",
          completion: Deferred.await(completion),
        }),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
      const launched = yield* launches.launch(
        launchInput({
          command: `command:launch:async-${exitCode}`,
          thread: `thread:launch:async-${exitCode}`,
          message: "Start during setup",
          workspace: { type: "worktree", baseRef: "main" },
        }),
      );
      yield* tracker.stream(launched.threadId).pipe(
        Stream.filter(
          (snapshot) =>
            snapshot?.stages.some((stage) => stage.id === "agent" && stage.status === "done") ===
            true,
        ),
        Stream.runHead,
      );
      const running = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(running.runs[0]?.status, "starting");
      assert.equal((yield* tracker.get(launched.threadId))?.phase, "running");
      yield* Deferred.succeed(completion, { exitCode, durationMs: 1 });
      yield* tracker.stream(launched.threadId).pipe(
        Stream.filter((snapshot) => snapshot?.phase === "done"),
        Stream.runHead,
      );
      const settled = yield* tracker.get(launched.threadId);
      assert.equal(
        settled?.stages.find((stage) => stage.id === "setup-script")?.status,
        exitCode === 0 ? "done" : "failed",
      );
      assert.equal(
        (yield* threads.getThreadProjection(launched.threadId)).runs[0]?.status,
        "starting",
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect.each([
  { name: "is missing", baseRef: "t3/renamed", startFromOrigin: false, origin: true },
  {
    name: "has no origin to come from",
    baseRef: "t3/renamed",
    startFromOrigin: true,
    origin: false,
  },
  {
    name: "is a previous checkout there never was",
    baseRef: "-",
    startFromOrigin: false,
    origin: true,
  },
])("refuses a new worktree whose base ref $name", (testCase) =>
  Effect.gen(function* () {
    const harness = makeHarness({
      hasCommit: ({ refName }) => Effect.succeed(refName === "HEAD"),
      git: {
        remoteExists: () => Effect.succeed(testCase.origin),
        hasRefNamed: () => Effect.succeed(false),
      },
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const error = yield* launches
        .checkWorktreeBase({
          projectId,
          workspaceStrategy: {
            type: "worktree",
            baseRef: testCase.baseRef,
            startFromOrigin: testCase.startFromOrigin,
          },
        })
        .pipe(Effect.flip);
      assert.deepInclude(error, {
        _tag: "ThreadLaunchBaseRefError",
        projectId,
        baseRef: testCase.baseRef,
      });
      assert.equal(
        error.message,
        `Base ref "${testCase.baseRef}" does not resolve to a commit in project "Project" (/repo).`,
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect.each([
  { name: "a base ref that resolves", baseRef: "main", commits: ["main", "HEAD"] },
  // Provisioning fetches it; the ref may exist nowhere else yet.
  {
    name: "a base ref only origin has",
    baseRef: "remote-only",
    startFromOrigin: true,
    commits: ["HEAD"],
  },
  // `git worktree add` starts from a remote-tracking branch of that name.
  {
    name: "a base ref a remote branch carries",
    baseRef: "remote-only",
    commits: ["HEAD"],
    remoteBranch: true,
  },
  // Provisioning runs such a repository without a worktree.
  { name: "a repository with no commits yet", baseRef: "main", commits: [] },
  { name: "the previous checkout", baseRef: "-", commits: ["@{-1}", "HEAD"] },
  { name: "a commit search", baseRef: ":/fix", commits: ["HEAD"] },
  { name: "a folder that is not a repository", baseRef: "main", commits: null },
])("leaves $name to the launch", (testCase) =>
  Effect.gen(function* () {
    const { commits } = testCase;
    const harness = makeHarness({
      git: { hasRefNamed: () => Effect.succeed(testCase.remoteBranch === true) },
      hasCommit: ({ refName }) =>
        commits === null
          ? Effect.fail(
              new GitCommandError({
                operation: "GitWorkflowService.hasCommit",
                command: "git rev-parse",
                cwd: "/repo",
                detail: "Not a Git repository.",
              }),
            )
          : Effect.succeed(commits.includes(refName)),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      yield* launches.checkWorktreeBase({
        projectId,
        workspaceStrategy: {
          type: "worktree",
          baseRef: testCase.baseRef,
          ...(testCase.startFromOrigin === undefined
            ? {}
            : { startFromOrigin: testCase.startFromOrigin }),
        },
      });
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("replays an accepted send after the project disables the instance", () => {
  const harness = makeHarness();
  const layerFiles = ServerConfig.layerTest(process.cwd(), { prefix: "t3-send-retry-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  );
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const created = yield* launches.launch(
      launchInput({
        command: "command:send:retry-setup",
        thread: "thread:send:retry-after-disable",
      }),
    );

    const sendInput = {
      commandId: CommandId.make("command:send:retry-after-disable"),
      projectId,
      threadId: created.threadId,
      messageId: MessageId.make("message:send:retry-after-disable"),
      text: "Hello again",
      attachments: [],
      mode: "auto" as const,
      createdBy: "user" as const,
      creationSource: "web" as const,
    };
    const first = yield* ThreadMessageIntake.sendToThread(sendInput);

    yield* settings.updateSettings({
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [modelSelection.instanceId]: { enabled: false } } },
      },
    });

    const retry = yield* ThreadMessageIntake.sendToThread(sendInput);
    assert.equal(retry.message.id, first.message.id);

    const fresh = yield* ThreadMessageIntake.sendToThread({
      ...sendInput,
      commandId: CommandId.make("command:send:fresh-after-disable"),
      messageId: MessageId.make("message:send:fresh-after-disable"),
    }).pipe(Effect.flip);
    if (fresh._tag !== "ThreadManagementProviderInstanceDisabledError") {
      assert.fail(`expected ThreadManagementProviderInstanceDisabledError, got ${fresh._tag}`);
    }
  }).pipe(Effect.provide(Layer.mergeAll(harness.layer, layerFiles)));
});

it.effect("replays an accepted message.dispatch after the project disables the instance", () => {
  const harness = makeHarness();
  const layerFiles = ServerConfig.layerTest(process.cwd(), { prefix: "t3-dispatch-retry-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  );
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const created = yield* launches.launch(
      launchInput({
        command: "command:dispatch:retry-setup",
        thread: "thread:dispatch:retry-after-disable",
      }),
    );

    const dispatchInput = {
      type: "message.dispatch" as const,
      commandId: CommandId.make("command:dispatch:retry-after-disable"),
      threadId: created.threadId,
      messageId: MessageId.make("message:dispatch:retry-after-disable"),
      text: "Hello again",
      attachments: [],
      dispatchMode: { type: "queue_after_active" as const },
      createdBy: "user" as const,
      creationSource: "web" as const,
    };
    const first = yield* ThreadMessageIntake.dispatchCommand(dispatchInput);

    yield* settings.updateSettings({
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [modelSelection.instanceId]: { enabled: false } } },
      },
    });

    const retry = yield* ThreadMessageIntake.dispatchCommand(dispatchInput);
    assert.deepEqual(retry, first);

    const fresh = yield* ThreadMessageIntake.dispatchCommand({
      ...dispatchInput,
      commandId: CommandId.make("command:dispatch:fresh-after-disable"),
      messageId: MessageId.make("message:dispatch:fresh-after-disable"),
    }).pipe(Effect.flip);
    if (fresh._tag !== "ThreadManagementProviderInstanceDisabledError") {
      assert.fail(`expected ThreadManagementProviderInstanceDisabledError, got ${fresh._tag}`);
    }
  }).pipe(Effect.provide(Layer.mergeAll(harness.layer, layerFiles)));
});

it.effect.each(
  (["codex", "claudeAgent"] as const).flatMap((driver) =>
    [
      { failSetup: false, failResolve: false },
      { failSetup: true, failResolve: false },
      { failSetup: false, failResolve: true },
      { failSetup: false, failResolve: false, cancelSetup: true },
      { failSetup: false, failResolve: false, cancelSetup: true, cancelAsync: true },
      { failSetup: false, failResolve: false, asyncSetup: "exits 1" },
      { failSetup: false, failResolve: false, asyncSetup: "times out" },
    ].flatMap((failures) =>
      [undefined, "/work/actual-repository"].map((repositoryPath) => ({
        driver,
        repositoryPath,
        cancelSetup: false,
        cancelAsync: false,
        asyncSetup: undefined as "exits 1" | "times out" | undefined,
        ...failures,
      })),
    ),
  ),
)(
  "prepares $driver delegated worktrees from $repositoryPath before execution, setup failure=$failSetup, commit failure=$failResolve, cancellation=$cancelSetup, async=$cancelAsync, async setup $asyncSetup",
  ({ driver, repositoryPath, failSetup, failResolve, cancelSetup, cancelAsync, asyncSetup }) =>
    Effect.gen(function* () {
      const setupEntered = yield* Deferred.make<void>();
      const allowSetup = yield* Deferred.make<void>();
      const terminalClosed = yield* Deferred.make<void>();
      const childInstanceId = ProviderInstanceId.make(`child-${driver}`);
      const parentWorktree = driver === "codex" ? null : "/parent-worktree";
      const resolveCommit = vi.fn(() =>
        failResolve
          ? Effect.fail(
              new GitCommandError({
                operation: "resolveCommit",
                command: "git",
                cwd: "/private-checkout",
                detail: "private Git failure details",
              }),
            )
          : Effect.succeed({ commitSha: "parent-local-commit" }),
      );
      const harness = makeHarness({
        closeTerminal: () => Deferred.succeed(terminalClosed, undefined).pipe(Effect.asVoid),
        adapters: [
          adapter,
          { ...adapter, instanceId: childInstanceId, driver: ProviderDriverKind.make(driver) },
        ],
        serverSettings: {
          providerInstances: {
            [childInstanceId]: { driver: ProviderDriverKind.make(driver), config: {} },
          },
        },
        hasCommit: () => Effect.succeed(true),
        providers: [
          {
            instanceId: childInstanceId,
            driver: ProviderDriverKind.make(driver),
            enabled: true,
            installed: true,
            version: "test",
            checkedAt: "2026-10-13T00:00:00.000Z",
            slashCommands: [],
            skills: [],
            status: "ready",
            auth: { status: "authenticated" },
            models: [{ slug: "child-model", name: "Child", isCustom: true, capabilities: null }],
          },
        ],
        runSetup: (setupInput) =>
          cancelSetup || asyncSetup !== undefined
            ? Effect.succeed({
                status: "started" as const,
                async: cancelAsync || asyncSetup !== undefined,
                scriptId: "setup",
                scriptName: "Setup",
                scriptCommand: "setup",
                terminalId: "setup",
                cwd: "/repo-worktrees/feature",
                completion: Deferred.succeed(setupEntered, undefined).pipe(
                  Effect.andThen(
                    asyncSetup === "times out" ? Effect.never : Deferred.await(allowSetup),
                  ),
                  Effect.andThen(
                    setupInput.observeCompletion?.onOutputLine?.("ERR_PNPM_FETCH_404") ??
                      Effect.void,
                  ),
                  Effect.as({ exitCode: asyncSetup === "exits 1" ? 1 : 0, durationMs: 0 }),
                ),
              })
            : Deferred.succeed(setupEntered, undefined).pipe(
                Effect.andThen(Deferred.await(allowSetup)),
                Effect.andThen(
                  failSetup
                    ? Effect.fail(
                        new ProjectSetupScriptRunner.ProjectSetupScriptOperationError({
                          threadId: "child",
                          worktreePath: "/repo-worktrees/feature",
                          operation: "writeCommand",
                          cause: "setup failed",
                        }),
                      )
                    : Effect.succeed({ status: "no-script" as const }),
                ),
              ),
      });
      const layerService = OrchestratorMcpService.layer.pipe(
        Layer.provide(
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
        ),
        Layer.provide(Layer.mock(UsageLimitSources.UsageLimitSources)({})),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(harness.layer),
        Layer.provide(
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            resolveCommit,
            execute: () =>
              Effect.succeed({
                exitCode: 0,
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              } as never),
          }),
        ),
        Layer.provide(Layer.mock(ScheduledTasks.ScheduledTaskService)({})),
        Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const parentThreadId = ThreadId.make("thread:delegated-worktree-parent");
        yield* threads.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-parent"),
          threadId: parentThreadId,
          projectId,
          title: "Parent",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "parent-feature",
          worktreePath: parentWorktree,
          createdBy: "user",
          creationSource: "web",
        });
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("start-parent"),
          threadId: parentThreadId,
          messageId: MessageId.make("parent-message"),
          text: "Delegate work",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const scope = {
          environmentId: EnvironmentId.make("delegated-worktree-test"),
          requestNamespace: "parent-session",
          thread: {
            threadId: parentThreadId,
            providerSessionId: "parent-session",
            providerInstanceId: modelSelection.instanceId,
          },
          client: undefined,
          capabilities: new Set(["orchestration"] as const),
          issuedAt: 1,
        };
        const input = {
          task: "Implement the child task",
          target: { providerInstanceId: childInstanceId, model: "child-model" },
          isolation: "worktree" as const,
          ...(repositoryPath === undefined ? {} : { repositoryPath }),
          clientRequestId: "isolated-child",
        };
        if (failResolve) {
          if (repositoryPath === undefined) {
            // Nothing to isolate: the child shares the parent's folder and says so.
            const delegated = yield* service.delegateTask(scope, input);
            assert.include(delegated.notice ?? "", "No worktree");
            assert.include(delegated.notice ?? "", parentWorktree ?? "/repo");
          } else {
            const error = yield* service.delegateTask(scope, input).pipe(Effect.flip);
            assert.equal(error.code, "invalid_request");
            assert.include(error.message, repositoryPath);
            assert.include(error.message, "Git repository with at least one commit");
            assert.include(error.message, 'isolation: "shared"');
            assert.isEmpty((yield* threads.getThreadProjection(parentThreadId)).subagents);
          }
          assert.equal(harness.createWorktree.mock.calls.length, 0);
          return;
        }
        // delegate_task returns at once; only the subagent waits for setup.
        const delegated = yield* service.delegateTask(scope, input);
        yield* Deferred.await(setupEntered);
        const child = yield* threads.getThreadProjection(delegated.childThreadId);
        assert.equal(child.thread.lineage.parentThreadId, parentThreadId);
        assert.equal(child.thread.worktreePath, "/repo-worktrees/feature");
        // A subagent waits for setup, even one marked async.
        assert.equal(child.runs[0]?.status, "preparing");
        assert.equal(child.thread.modelSelection.instanceId, childInstanceId);
        assert.equal(child.thread.modelSelection.model, "child-model");
        // A parent in its own worktree also checks the project root can reach its commit.
        const resolved = [
          [{ cwd: repositoryPath ?? parentWorktree ?? "/repo", revision: "HEAD" }],
          ...(repositoryPath === undefined && parentWorktree !== null
            ? [[{ cwd: "/repo", revision: "parent-local-commit" }]]
            : []),
        ];
        assert.deepEqual(resolveCommit.mock.calls, resolved);
        assert.equal(harness.createWorktree.mock.calls[0]?.[0].refName, "parent-local-commit");
        assert.equal(harness.createWorktree.mock.calls[0]?.[0].cwd, repositoryPath ?? "/repo");
        if (repositoryPath !== undefined) {
          const preparation = child.runs[0]?.workspacePreparation;
          assert.equal(
            preparation?.type === "worktree" ? preparation.sourcePath : undefined,
            repositoryPath,
          );
        }
        assert.equal((yield* service.delegateTask(scope, input)).taskId, delegated.taskId);
        assert.equal(harness.createWorktree.mock.calls.length, 1);
        assert.equal(resolveCommit.mock.calls.length, resolved.length);
        assert.isEmpty(child.checkpointScopes);
        const parent = yield* threads.getThreadProjection(parentThreadId);
        assert.equal(parent.thread.worktreePath, parentWorktree);
        assert.equal(parent.thread.branch, "parent-feature");
        if (cancelSetup) {
          yield* service.cancelTask(scope, { taskId: delegated.taskId });
          yield* Deferred.await(terminalClosed);
          yield* threads.streamStoredEventsFrom({ threadId: delegated.childThreadId }).pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "thread.metadata-updated" &&
                stored.event.payload.worktreePath === null,
            ),
            Stream.runHead,
          );
          assert.equal(harness.closeTerminal.mock.calls.length, 1);
          assert.equal(harness.removeWorktree.mock.calls.length, 1);
          const cancelled = yield* threads.getThreadProjection(delegated.childThreadId);
          assert.equal(cancelled.runs[0]?.status, "interrupted");
          assert.isNull(cancelled.thread.worktreePath);
          assert.isEmpty(cancelled.checkpointScopes);
          return;
        }
        yield* Deferred.succeed(allowSetup, undefined);
        if (asyncSetup === "times out") {
          // The wait starts beside the setup; advance until it has expired.
          yield* waitUntil(() =>
            TestClock.adjust("10 minutes").pipe(
              Effect.andThen(threads.getThreadProjection(delegated.childThreadId)),
              Effect.map((current) => current.runs[0]?.status === "starting"),
            ),
          );
        }
        yield* threads
          .streamStoredEventsFrom({ threadId: delegated.childThreadId, eventType: "run.updated" })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "run.updated" && stored.event.payload.status === "starting",
            ),
            Stream.runHead,
          );
        // Setup that could not start or failed still starts the subagent, which
        // is told. A repository without a setup script starts it with no notice.
        const prepared = yield* threads.getThreadProjection(delegated.childThreadId);
        assert.equal(prepared.checkpointScopes[0]?.cwd, "/repo-worktrees/feature");
        const expectedNotice =
          asyncSetup === "exits 1"
            ? "Project setup failed (exit 1: ERR_PNPM_FETCH_404); dependencies may be missing."
            : asyncSetup === "times out"
              ? "Project setup was still running after 10 minutes; dependencies may be missing."
              : failSetup
                ? "Project setup could not start"
                : undefined;
        const notice = workspaceSetupNotice(prepared.turnItems, prepared.runs[0]!.id);
        if (expectedNotice === undefined) assert.isUndefined(notice);
        else assert.include(notice ?? "", expectedNotice);
        // The parent is told where the child's commits will be.
        assert.equal(
          (yield* service.taskStatus(scope, delegated.taskId)).worktree?.path,
          "/repo-worktrees/feature",
        );
      }).pipe(Effect.provide(Layer.merge(harness.layer, layerService)));
    }),
);

it.effect("keeps Models helpers out of server chat lists but directly readable", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const helper = yield* launches.launch(
      launchInput({ command: "command:models:helper", thread: "models:saved" }),
    );
    const user = yield* launches.launch(
      launchInput({ command: "command:models:user", thread: "user-models" }),
    );
    const listed = yield* threads.listProjectThreads({ projectId, includeSubagents: true });
    assert.deepEqual(
      listed.map((thread) => thread.id),
      [user.threadId],
    );
    assert.equal((yield* threads.getThreadProjection(helper.threadId)).thread.id, helper.threadId);
  }).pipe(Effect.provide(harness.layer));
});

it.effect(
  "persists a compact debug context on bootstrap without storing workflow instructions",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const debug = expandDebugCommand("/debug stale phone");
      const input = {
        ...launchInput({ command: "debug-bootstrap", thread: "debug-bootstrap" }),
        initialMessage: {
          messageId: MessageId.make("debug-bootstrap-message"),
          ...debug,
          attachments: [],
        },
      };
      yield* launches.launch(input);
      const stored = yield* threads.getThreadProjection(input.threadId);
      assert.equal(stored.messages[0]?.text, debug.text);
      assert.deepEqual(stored.messages[0]?.context, debug.context);
      assert.notInclude(JSON.stringify(stored.messages), "hypotheses");
      const item = stored.turnItems.find((item) => item.type === "user_message");
      assert.isDefined(item);
      if (item?.type === "user_message") assert.deepEqual(item.context, debug.context);
    }).pipe(Effect.provide(harness.layer));
  },
);

const pickedModel = { instanceId: modelSelection.instanceId, model: "gpt-5.1-codex-mini" } as const;

it.effect("the user starts a subagent in a chat whose lead is mid-turn", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const lead = yield* launches.launch(
      launchInput({ command: "user-agent-lead", thread: "user-agent-lead", message: "Lead work" }),
    );
    const started = yield* launches.startUserSubagent({
      commandId: CommandId.make("user-agent-start"),
      creationSource: "mobile",
      threadId: lead.threadId,
      task: "Check why the build is slow",
      modelSelection: pickedModel,
    });
    assert.equal(started.workspace, "shared");

    const after = yield* threads.getThreadProjection(lead.threadId);
    const task = after.subagents.find((candidate) => candidate.id === started.taskId);
    assert.deepInclude(task, {
      origin: "app_owned",
      createdBy: "user",
      runId: after.runs[0]!.id,
      prompt: "Check why the build is slow",
      model: pickedModel.model,
      // The lead may be idle by the time it finishes: the result must still reach it.
      completionWake: "always",
      childThreadId: started.childThreadId,
    });
    // The lead's chat shows a card for it like for one of its own.
    assert.isDefined(
      after.turnItems.find(
        (item) => item.type === "subagent" && item.subagentId === started.taskId,
      ),
    );

    const child = yield* threads.getThreadProjection(started.childThreadId);
    assert.deepInclude(child.thread, {
      createdBy: "user",
      creationSource: "mobile",
      modelSelection: pickedModel,
      runtimeMode: after.thread.runtimeMode,
      interactionMode: "default",
    });
    assert.deepInclude(child.thread.lineage, {
      relationshipToParent: "subagent",
      parentThreadId: lead.threadId,
    });
    // The chat shows the task exactly as typed.
    assert.equal(child.messages[0]?.text, "Check why the build is slow");
    assert.lengthOf(child.runs, 1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("a subagent the user starts in an idle chat joins the last turn that ran", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const lead = yield* launches.launch(
      launchInput({ command: "idle-lead", thread: "idle-lead", message: "Lead work" }),
    );
    const run = (yield* threads.getThreadProjection(lead.threadId)).runs[0]!;
    yield* sink.write({
      events: [
        {
          id: EventId.make("idle-lead:run-ended"),
          type: "run.updated",
          threadId: lead.threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "completed", startedAt: now, completedAt: now },
        },
      ],
    });

    // Only the user may attach work to a turn that has ended.
    const agentRequest = yield* threads
      .dispatch({
        type: "delegated_task.request",
        createdBy: "agent",
        creationSource: "mcp",
        commandId: CommandId.make("idle-lead:agent-request"),
        parentThreadId: lead.threadId,
        parentRunId: run.id,
        parentNodeId: run.rootNodeId!,
        task: "An agent cannot start this",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      })
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(agentRequest));

    const started = yield* launches.startUserSubagent({
      commandId: CommandId.make("idle-lead:user-start"),
      threadId: lead.threadId,
      task: "Summarise the open pull requests",
      modelSelection: pickedModel,
    });
    const after = yield* threads.getThreadProjection(lead.threadId);
    assert.deepInclude(
      after.subagents.find((candidate) => candidate.id === started.taskId),
      { createdBy: "user", runId: run.id, completionWake: "always", status: "running" },
    );
    // The lead's finished turn stays finished: starting a subagent costs it nothing.
    assert.equal(after.runs.find((candidate) => candidate.id === run.id)?.status, "completed");
    assert.lengthOf(after.runs, 1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("a subagent the user starts needs an open chat that has had a turn", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const empty = yield* launches.launch(launchInput({ command: "empty-lead", thread: "empty" }));
    const neverRan = yield* launches
      .startUserSubagent({
        commandId: CommandId.make("empty-lead:start"),
        threadId: empty.threadId,
        task: "Anything",
        modelSelection,
      })
      .pipe(Effect.flip);
    assert.include(neverRan.message, "Send this chat a message first");
    const missing = yield* launches
      .startUserSubagent({
        commandId: CommandId.make("missing-lead:start"),
        threadId: ThreadId.make("thread:not-there"),
        task: "Anything",
        modelSelection,
      })
      .pipe(Effect.flip);
    assert.equal(missing.message, "This chat is no longer open.");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("a subagent the user starts gets its own copy of the lead's repository", () => {
  const harness = makeHarness({ hasCommit: () => Effect.succeed(true) });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const lead = yield* launches.launch(
      launchInput({ command: "repo-lead", thread: "repo-lead", message: "Lead work" }),
    );
    const started = yield* launches.startUserSubagent({
      commandId: CommandId.make("repo-lead:start"),
      threadId: lead.threadId,
      task: "Fix the flaky test",
      modelSelection,
    });
    assert.equal(started.workspace, "own_copy");
    const child = yield* threads.getThreadProjection(started.childThreadId);
    // The project's own repository needs no source path.
    assert.deepEqual(child.runs[0]?.workspacePreparation, {
      type: "worktree",
      baseRef: "HEAD",
      startFromOrigin: false,
    });
  }).pipe(Effect.provide(harness.layer));
});

it.effect("a subagent the user starts works where the lead's own subagents last worked", () => {
  // A scratch chat: its own folder is no repository, the lead delegates into one elsewhere.
  const harness = makeHarness({
    hasCommit: (input) => Effect.succeed(input.cwd === "/elsewhere/repository"),
  });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const lead = yield* launches.launch(
      launchInput({ command: "scratch-lead", thread: "scratch-lead", message: "Lead work" }),
    );
    const first = yield* launches.startUserSubagent({
      commandId: CommandId.make("scratch-lead:first"),
      threadId: lead.threadId,
      task: "First task",
      modelSelection,
    });
    assert.equal(first.workspace, "shared");
    const siblingRun = (yield* threads.getThreadProjection(first.childThreadId)).runs[0]!;
    yield* sink.write({
      events: [
        {
          id: EventId.make("scratch-lead:sibling-worktree"),
          type: "run.updated",
          threadId: first.childThreadId,
          runId: siblingRun.id,
          occurredAt: now,
          payload: {
            ...siblingRun,
            workspacePreparation: {
              type: "worktree",
              baseRef: "abc123",
              startFromOrigin: false,
              sourcePath: "/elsewhere/repository",
            },
          },
        },
      ],
    });
    const second = yield* launches.startUserSubagent({
      commandId: CommandId.make("scratch-lead:second"),
      threadId: lead.threadId,
      task: "Second task",
      modelSelection,
    });
    assert.equal(second.workspace, "own_copy");
    assert.deepEqual(
      (yield* threads.getThreadProjection(second.childThreadId)).runs[0]?.workspacePreparation,
      {
        type: "worktree",
        baseRef: "HEAD",
        startFromOrigin: false,
        sourcePath: "/elsewhere/repository",
      },
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("admits an implicit-model send against the account used by its run", () =>
  Effect.gen(function* () {
    const read = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let intercept = false;
    let policyReads = 0;
    const second = ProviderInstanceId.make("codex_work");
    const harness = makeHarness({
      adapters: [adapter, { ...adapter, instanceId: second }],
      serverSettings: {
        providerInstances: { [second]: { driver: "codex", enabled: true } },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [second]: { enabled: false } } },
        },
      },
      afterPolicyRead: Effect.suspend(() => {
        policyReads++;
        return intercept
          ? Deferred.succeed(read, undefined).pipe(Effect.andThen(Deferred.await(resume)))
          : Effect.void;
      }),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const { threadId } = yield* launches.launch(
        launchInput({ command: "admission:create", thread: "admission" }),
      );
      intercept = true;
      const send = {
        type: "message.dispatch",
        commandId: CommandId.make("admission:send"),
        threadId,
        messageId: MessageId.make("admission:message"),
        text: "Check",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "mobile",
      } as const;
      const sending = yield* threads.dispatch(send).pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(read);
      intercept = false;
      yield* threads.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("admission:selection"),
        threadId,
        modelSelection: { ...modelSelection, instanceId: second },
      });
      yield* Deferred.succeed(resume, undefined);
      const outcome = yield* Fiber.join(sending);
      const records = yield* threads.getThreadProjection(threadId);
      assert.equal(outcome._tag, "Failure");
      if (outcome._tag === "Failure")
        assert.equal(outcome.failure._tag, "ThreadManagementProviderInstanceDisabledError");
      assert.deepEqual(records.runs, []);
      assert.deepEqual(records.messages, []);
      assert.equal(yield* threads.hasReceipt(send.commandId), false);
      yield* threads.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("admission:restore"),
        threadId,
        modelSelection,
      });
      const accepted = yield* threads.dispatch(send);
      const readsBeforeReplay = policyReads;
      const replay = yield* threads.dispatch(send);
      assert.equal(policyReads, readsBeforeReplay);
      assert.equal(replay.sequence, accepted.sequence);
      assert.deepEqual(
        (yield* threads.getThreadProjection(threadId)).runs.map((run) => run.providerInstanceId),
        [modelSelection.instanceId],
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);
