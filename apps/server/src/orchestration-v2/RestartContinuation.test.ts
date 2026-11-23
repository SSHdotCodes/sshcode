import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ServerSettingsError,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerSettings from "../serverSettings.ts";
import { restartContinuationRun, continueRestartedRun } from "./RestartContinuation.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";

const threadId = ThreadId.make("thread:restart");
const runId = RunId.make("run:restart");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const providerThreadId = ProviderThreadId.make("provider-thread:restart");
const sessionId = ProviderSessionId.make("session:restart");
const attemptId = RunAttemptId.make("attempt:restart");
// "No project" threads belong to the environment's Scratch project.
const scratchProjectId = ProjectId.make("project:scratch");
const now = DateTime.makeUnsafe("2026-10-03T12:00:00.000Z");
const settingsReadError = new ServerSettingsError({
  operation: "read-secret",
  settingsPath: "fixture/settings.json",
});

function makeProjection() {
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("restart-project"),
      providerInstanceId: instanceId,
      archivedAt: null,
      deletedAt: null,
    },
    runs: [
      {
        id: runId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "gpt-6" },
        providerThreadId,
        activeAttemptId: attemptId,
        status: "running",
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        appThreadId: threadId,
        ownerNodeId: null,
        driver,
        providerInstanceId: instanceId,
        providerSessionId: sessionId,
        nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
        status: "active",
      },
    ],
    providerSessions: [
      { id: sessionId, driver, providerInstanceId: instanceId, status: "running" },
    ],
    providerTurns: [
      {
        id: ProviderTurnId.make("turn:restart"),
        providerThreadId,
        runAttemptId: attemptId,
        status: "running",
      },
    ],
    runtimeRequests: [],
    attempts: [],
    nodes: [],
    subagents: [],
    messages: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
}

it("requires matching saved native state for an unfinished root run", () => {
  const projection = makeProjection();
  assert.equal(restartContinuationRun(projection, now)?.id, runId);
  for (const invalid of [
    { ...projection, thread: { ...projection.thread, archivedAt: {} } },
    { ...projection, thread: { ...projection.thread, deletedAt: {} } },
    {
      ...projection,
      thread: { ...projection.thread, providerInstanceId: ProviderInstanceId.make("other") },
    },
    {
      ...projection,
      providerThreads: [{ ...projection.providerThreads[0]!, nativeThreadRef: null }],
    },
    {
      ...projection,
      providerSessions: [
        {
          ...projection.providerSessions[0]!,
          providerInstanceId: ProviderInstanceId.make("other"),
        },
      ],
    },
    ...[
      "queued",
      "preparing",
      "starting",
      "waiting",
      "completed",
      "cancelled",
      "failed",
      "interrupted",
    ].map((status) => ({ ...projection, runs: [{ ...projection.runs[0]!, status }] })),
  ])
    assert.isUndefined(restartContinuationRun(invalid as OrchestrationV2ThreadProjection, now));
});

it("continues a live turn whose session the adapter never marked running", () => {
  const projection = makeProjection();
  // Codex, Claude, Cursor and ACP sessions stay "ready" for their whole life.
  const withSessionStatus = (status: string) =>
    ({
      ...projection,
      providerSessions: [{ ...projection.providerSessions[0]!, status }],
    }) as OrchestrationV2ThreadProjection;
  for (const status of ["starting", "ready", "running", "waiting"])
    assert.equal(restartContinuationRun(withSessionStatus(status), now)?.id, runId, status);
  for (const status of ["stopped", "error"])
    assert.isUndefined(restartContinuationRun(withSessionStatus(status), now), status);
});

it("recovers an admitted continuation after another crash before provider start", () => {
  const projection = makeProjection();
  const starting = {
    ...projection,
    runs: [
      {
        ...projection.runs[0]!,
        status: "starting" as const,
        restartContinuationOfRunId: RunId.make("run:previous-crash"),
      },
    ],
    providerThreads: [{ ...projection.providerThreads[0]!, status: "idle" as const }],
    providerSessions: [{ ...projection.providerSessions[0]!, status: "stopped" as const }],
    providerTurns: [],
  };
  assert.equal(restartContinuationRun(starting, now)?.id, runId);
});

it("does not continue settled root runs with restart-cancelled background work", () => {
  const projection = makeProjection();
  const settled = {
    ...projection,
    runs: [
      {
        ...projection.runs[0]!,
        status: "completed" as const,
        restartCancelledBackgroundWork: [{ kind: "shell" as const, label: "sleep 25" }],
      },
    ],
    providerThreads: [{ ...projection.providerThreads[0]!, status: "idle" as const }],
    providerSessions: [{ ...projection.providerSessions[0]!, status: "stopped" as const }],
    providerTurns: [],
  };
  for (const projectId of [scratchProjectId, projection.thread.projectId])
    for (const status of ["completed", "waiting"] as const)
      assert.isUndefined(
        restartContinuationRun(
          {
            ...settled,
            thread: { ...settled.thread, projectId },
            runs: [{ ...settled.runs[0]!, status }],
          },
          now,
        ),
      );
});

it.effect.each(["completed", "waiting", "cancelled"] as const)(
  "ignores a pending restart continuation for a %s run whose provider turn settled",
  (status) =>
    Effect.gen(function* () {
      const base = makeProjection();
      const work = [{ kind: "shell" as const, label: "sleep 25 && echo DONE" }];
      const projection = {
        ...base,
        runs: [{ ...base.runs[0]!, status, restartCancelledBackgroundWork: work }],
        providerTurns: [{ ...base.providerTurns[0]!, status: "completed" }],
      } as unknown as OrchestrationV2ThreadProjection;
      const commands: Parameters<
        ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
      >[0][] = [];
      yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
        Effect.provide(
          Layer.merge(
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadRecords: () => Effect.succeed(projection),
              recoverDelegatedTask: () => Effect.void,
              dispatch: (command) => {
                commands.push(command);
                return Effect.succeed({} as never);
              },
            }),
            ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          ),
        ),
      );
      assert.lengthOf(commands, 0);
    }),
);

it.effect.each(["completed", "waiting", "cancelled"] as const)(
  "wakes a %s run whose monitor the restart cancelled, with the note as its prompt",
  (status) =>
    Effect.gen(function* () {
      const base = makeProjection();
      const work = [
        { kind: "monitor" as const, label: "Watch CI run 42" },
        { kind: "shell" as const, label: "vp run dev" },
      ];
      const projection = {
        ...base,
        runs: [{ ...base.runs[0]!, status, restartCancelledBackgroundWork: work }],
        providerTurns: [{ ...base.providerTurns[0]!, status: "completed" }],
      } as unknown as OrchestrationV2ThreadProjection;
      const commands: Parameters<
        ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
      >[0][] = [];
      yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
        Effect.provide(
          Layer.merge(
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadRecords: () => Effect.succeed(projection),
              recoverDelegatedTask: () => Effect.void,
              dispatch: (command) => {
                commands.push(command);
                return Effect.succeed({} as never);
              },
            }),
            ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          ),
        ),
      );
      assert.lengthOf(commands, 1);
      const command = commands[0]!;
      assert.equal(command.type, "message.dispatch");
      if (command.type !== "message.dispatch") return;
      assert.equal(command.restartContinuationOfRunId, runId);
      assert.include(command.text, "- monitor: Watch CI run 42");
      assert.include(command.text, "- shell: vp run dev");
    }),
);

it.effect("does not continue a failed run that lost background work", () =>
  Effect.gen(function* () {
    const base = makeProjection();
    const projection = {
      ...base,
      runs: [
        {
          ...base.runs[0]!,
          status: "failed",
          restartCancelledBackgroundWork: [{ kind: "shell" as const, label: "sleep 25" }],
        },
      ],
      providerTurns: [{ ...base.providerTurns[0]!, status: "failed" }],
    } as unknown as OrchestrationV2ThreadProjection;
    const commands: Parameters<
      ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
    >[0][] = [];
    yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(projection),
            recoverDelegatedTask: () => Effect.void,
            dispatch: (command) => {
              commands.push(command);
              return Effect.succeed({} as never);
            },
          }),
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
        ),
      ),
    );
    assert.lengthOf(commands, 0);
  }),
);

it.effect.each([
  [false, undefined],
  [true, undefined],
  [false, true],
  [true, false],
  [undefined, undefined],
] as const)(
  "atomically records restart intent with cancellation when opt-in is %s and project override is %s",
  ([enabled, projectOverride]) =>
    Effect.gen(function* () {
      let committed: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | undefined;
      const recovery = yield* ProviderRuntimeRecovery.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            enabled === undefined
              ? Layer.mock(ServerSettings.ServerSettingsService)({
                  getSettings: Effect.fail(settingsReadError),
                })
              : ServerSettings.layerTest({
                  continueThreadsAfterServerUpdate: enabled,
                  projectSettingsOverrides:
                    projectOverride === undefined
                      ? {}
                      : {
                          [ProjectId.make("restart-project")]: {
                            continueThreadsAfterServerUpdate: projectOverride,
                          },
                        },
                }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getRecoveryThreadIds: () => Effect.succeed([threadId]),
              getRuntimeRecoveryProjection: () => Effect.succeed(makeProjection()),
              getNextTurnItemOrdinal: () => Effect.succeed(42),
            }),
            Layer.mock(EventSink.EventSinkV2)({
              commitCommand: (input) => {
                committed = input;
                return Effect.succeed({ committed: true, cancelledEffectCount: 1 } as never);
              },
            }),
            IdAllocator.layer,
            Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
              runRecoveryOnce: Effect.succeed(false),
            }),
            Layer.mock(EffectOutbox.EffectOutboxV2)({
              reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
            }),
          ),
        ),
      );
      yield* recovery.reconcile("startup");
      assert.isDefined(committed);
      assert.isTrue(
        committed!.events.some(
          (event) => event.type === "run.updated" && event.payload.status === "cancelled",
        ),
      );
      const expectContinuation = projectOverride ?? enabled ?? true;
      assert.lengthOf(committed!.effects, expectContinuation ? 1 : 0);
      if (expectContinuation)
        assert.deepEqual(committed!.effects[0]?.request, {
          type: "provider-runtime.continue",
          sourceRunId: runId,
        });
    }),
);

it.effect("lets a cut blocking delegate_task wake its parent like an async task", () =>
  Effect.gen(function* () {
    const base = makeProjection();
    const task = (id: string, completionWake: "settled_only" | "always", status: string) => ({
      id: NodeId.make(id),
      threadId,
      runId,
      origin: "app_owned",
      childThreadId: ThreadId.make(`thread:${id}`),
      driver,
      providerInstanceId: instanceId,
      completionWake,
      status,
    });
    const projection = {
      ...base,
      subagents: [
        task("task:waited", "settled_only", "running"),
        task("task:async", "always", "running"),
        task("task:finished", "settled_only", "completed"),
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    let committed: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | undefined;
    const recovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
            getNextTurnItemOrdinal: () => Effect.succeed(42),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committed = input;
              return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({}),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );
    yield* recovery.reconcile("startup");
    const upgraded = (committed?.events ?? []).flatMap((event) =>
      event.type === "subagent.updated" ? [event.payload] : [],
    );
    assert.deepEqual(
      upgraded.map((row) => ({ id: row.id, completionWake: row.completionWake })),
      [{ id: NodeId.make("task:waited"), completionWake: "always" }],
    );
  }),
);

it.effect("does not duplicate delivery and yields to newer user work or opt-out", () =>
  Effect.gen(function* () {
    let projection = makeProjection();
    projection = { ...projection, runs: [{ ...projection.runs[0]!, status: "cancelled" }] };
    const commands: Parameters<
      ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
    >[0][] = [];
    const layerThreads = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: () => Effect.succeed(projection),
      recoverDelegatedTask: () => Effect.void,
      dispatch: (command) => {
        commands.push(command);
        if (command.type === "message.dispatch")
          projection = { ...projection, messages: [{ id: command.messageId } as never] };
        return Effect.succeed({} as never);
      },
    });
    const layerEnabled = Layer.merge(
      layerThreads,
      ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
    );
    yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
      Effect.provide(layerEnabled),
    );
    yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
      Effect.provide(layerEnabled),
    );
    assert.lengthOf(commands, 1);
    assert.match(String(commands[0]!.commandId), /run:restart$/);
    if (commands[0]!.type === "message.dispatch")
      assert.equal(commands[0]!.restartContinuationOfRunId, runId);
    projection = {
      ...projection,
      messages: [],
      runs: [
        ...projection.runs,
        {
          ...projection.runs[0]!,
          id: RunId.make("run:user-newer"),
          ordinal: 2,
          status: "completed",
        },
      ],
    };
    yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
      Effect.provide(layerEnabled),
    );
    assert.lengthOf(commands, 1);
    projection = { ...projection, runs: [projection.runs[0]!] };
    yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
      Effect.provide(
        Layer.merge(
          layerThreads,
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: false }),
        ),
      ),
    );
    assert.lengthOf(commands, 1);
  }),
);

it.effect("prepares no continuation for background work another provider thread launched", () =>
  Effect.gen(function* () {
    const base = makeProjection();
    const claudeThreadId = ProviderThreadId.make("provider-thread:claude");
    // A Claude turn left a background subagent open, then the thread switched
    // to Codex and its turn settled. Recovery would cancel Claude's work.
    const projection = {
      ...base,
      runs: [{ ...base.runs[0]!, status: "completed" }],
      providerTurns: [{ ...base.providerTurns[0]!, status: "completed" }],
      turnItems: [
        {
          id: "turn-item:claude-subagent",
          runId: RunId.make("run:claude"),
          providerThreadId: claudeThreadId,
          type: "subagent",
          status: "running",
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const writes: Parameters<EventSink.EventSinkV2["Service"]["writeWithEffects"]>[0][] = [];
    const recovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            writeWithEffects: (input) =>
              Effect.sync(() => {
                writes.push(input);
                return [];
              }),
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({}),
          Layer.mock(EffectOutbox.EffectOutboxV2)({}),
        ),
      ),
    );
    yield* recovery.prepareForShutdown;
    assert.lengthOf(writes, 0);
    // The same work on the settled run's own provider thread does wake it.
    const ownWork = {
      ...projection,
      turnItems: [{ ...projection.turnItems[0]!, providerThreadId }],
    } as OrchestrationV2ThreadProjection;
    const ownRecovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(ownWork),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            writeWithEffects: (input) =>
              Effect.sync(() => {
                writes.push(input);
                return [];
              }),
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({}),
          Layer.mock(EffectOutbox.EffectOutboxV2)({}),
        ),
      ),
    );
    yield* ownRecovery.prepareForShutdown;
    assert.lengthOf(writes, 1);
    assert.deepEqual(writes[0]!.effects[0]?.request, {
      type: "provider-runtime.continue",
      sourceRunId: runId,
    });
  }),
);

const backgroundSubagent = {
  turnItem: {
    id: "turn-item:background-subagent",
    runId,
    nodeId: null,
    providerThreadId,
    providerInstanceId: instanceId,
    type: "subagent",
    subagentId: "subagent:background",
    title: "Background reviewer",
    status: "running",
  },
  work: {
    kind: "subagent" as const,
    label: "Background reviewer",
    id: "turn-item:background-subagent",
  },
};
const devServer = {
  turnItem: {
    id: "turn-item:dev-server",
    runId,
    nodeId: null,
    providerThreadId,
    providerInstanceId: instanceId,
    type: "command_execution",
    input: "vp run dev",
    status: "running",
  },
  work: { kind: "shell" as const, label: "vp run dev", id: "turn-item:dev-server" },
};
// Claude Code wakes the agent when any background command ends, so a Claude
// turn that settled with one running was waiting on it.
const claudeBackgroundWait = {
  turnItem: {
    ...devServer.turnItem,
    id: "turn-item:claude-wait",
    input: "until grep -q DONE eval.log; do sleep 30; done",
  },
  work: {
    kind: "shell" as const,
    label: "until grep -q DONE eval.log; do sleep 30; done",
    id: "turn-item:claude-wait",
    wakesAgent: true,
  },
  driver: ProviderDriverKind.make("claudeAgent"),
};

it.effect.each([
  ["completed", scratchProjectId, backgroundSubagent, true],
  ["waiting", ProjectId.make("restart-project"), backgroundSubagent, true],
  ["completed", ProjectId.make("restart-project"), devServer, false],
  ["waiting", scratchProjectId, devServer, false],
  ["completed", scratchProjectId, claudeBackgroundWait, true],
] as const)(
  "cleans up background work of a %s run in project %s and wakes it only for awaited work",
  ([status, projectId, background, wakes]) =>
    Effect.gen(function* () {
      const base = makeProjection();
      const projection = {
        ...base,
        thread: { ...base.thread, projectId },
        runs: [{ ...base.runs[0]!, status }],
        providerTurns: [{ ...base.providerTurns[0]!, status: "completed" }],
        turnItems: [background.turnItem],
        providerThreads:
          "driver" in background
            ? base.providerThreads.map((thread) => ({
                ...thread,
                driver: background.driver,
                nativeThreadRef: { ...thread.nativeThreadRef, driver: background.driver },
              }))
            : base.providerThreads,
        providerSessions:
          "driver" in background
            ? base.providerSessions.map((session) => ({ ...session, driver: background.driver }))
            : base.providerSessions,
        subagents:
          background === backgroundSubagent
            ? [
                {
                  id: "subagent:background",
                  runId,
                  origin: "provider_native",
                  driver,
                  providerInstanceId: instanceId,
                  status: "running",
                },
              ]
            : [],
      } as unknown as OrchestrationV2ThreadProjection;
      for (const trigger of ["startup", "shutdown"] as const) {
        const commits: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0][] = [];
        const writes: Parameters<EventSink.EventSinkV2["Service"]["writeWithEffects"]>[0][] = [];
        const recovery = yield* ProviderRuntimeRecovery.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getRecoveryThreadIds: () => Effect.succeed([threadId]),
                getRuntimeRecoveryProjection: () => Effect.succeed(projection),
                getNextTurnItemOrdinal: () => Effect.succeed(42),
              }),
              Layer.mock(EventSink.EventSinkV2)({
                writeWithEffects: (input) =>
                  Effect.sync(() => {
                    writes.push(input);
                    return [];
                  }),
                commitCommand: (input) =>
                  Effect.sync(() => {
                    commits.push(input);
                    return { committed: true, cancelledEffectCount: 0 } as never;
                  }),
              }),
              IdAllocator.layer,
              Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
                runRecoveryOnce: Effect.succeed(false),
              }),
              Layer.mock(EffectOutbox.EffectOutboxV2)({
                listByCommandId: () => Effect.succeed([]),
                reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
              }),
            ),
          ),
        );
        if (trigger === "shutdown") yield* recovery.prepareForShutdown;
        yield* recovery.reconcile(trigger);
        // Shutdown records the wake before it cancels the work; a startup
        // after a kill records it with the cancellation.
        const recorded = [...writes.flatMap((write) => write.effects), ...commits[0]!.effects];
        assert.deepEqual(
          recorded.map((effect) => effect.request),
          wakes ? [{ type: "provider-runtime.continue", sourceRunId: runId }] : [],
        );
        assert.lengthOf(commits, 1);
        const events = commits[0]!.events;
        assert.isTrue(
          events.some(
            (event) => event.type === "turn-item.updated" && event.payload.status === "cancelled",
          ),
        );
        const note = events.find((event) => event.type === "run.background-work-cancelled");
        assert.equal(note?.runId, runId);
        assert.deepEqual(note?.payload.restartCancelledBackgroundWork, [background.work]);
        if (status === "completed")
          assert.isFalse(events.some((event) => event.type === "run.updated"));
      }
    }),
);

it("does not wake a settled run for work left by a session that already stopped", () => {
  const base = makeProjection();
  const projection = {
    ...base,
    runs: [{ ...base.runs[0]!, status: "completed" }],
    providerThreads: [{ ...base.providerThreads[0]!, status: "idle" }],
    turnItems: [backgroundSubagent.turnItem],
  } as unknown as OrchestrationV2ThreadProjection;
  assert.equal(restartContinuationRun(projection, now)?.id, runId);
  for (const status of ["stopped", "error"])
    assert.isUndefined(
      restartContinuationRun(
        {
          ...projection,
          providerSessions: [{ ...projection.providerSessions[0]!, status }],
        } as OrchestrationV2ThreadProjection,
        now,
      ),
      status,
    );
});

it.effect("does not cancel or resume a run that completes while shutdown intent commits", () =>
  Effect.gen(function* () {
    let projection = makeProjection();
    const commits: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0][] = [];
    const recovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.sync(() => projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            writeWithEffects: (input) =>
              Effect.sync(() => {
                assert.lengthOf(input.events, 0);
                assert.equal(input.effects[0]?.request.type, "provider-runtime.continue");
                projection = {
                  ...projection,
                  runs: [{ ...projection.runs[0]!, status: "completed" }],
                };
                return [];
              }),
            commitCommand: (input) =>
              Effect.sync(() => {
                commits.push(input);
                return { committed: true, cancelledEffectCount: 0 } as never;
              }),
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );
    yield* recovery.prepareForShutdown;
    yield* recovery.reconcile("shutdown");
    assert.isFalse(
      commits.some((commit) => commit.events.some((event) => event.type === "run.updated")),
    );
    let dispatched = false;
    yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(projection),
            recoverDelegatedTask: () => Effect.void,
            dispatch: () =>
              Effect.sync(() => {
                dispatched = true;
                return {} as never;
              }),
          }),
        ),
      ),
    );
    assert.isFalse(dispatched);
  }),
);

it.effect("leaves a restart continuation retryable when settings cannot be read", () =>
  Effect.gen(function* () {
    const result = yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.fail(settingsReadError),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            recoverDelegatedTask: () => Effect.void,
          }),
        ),
      ),
      Effect.result,
    );
    assert.equal(result._tag, "Failure");
  }),
);

const continuationDispatches = (projection: OrchestrationV2ThreadProjection) =>
  Effect.gen(function* () {
    const dispatches: Array<Extract<OrchestrationV2Command, { type: "message.dispatch" }>> = [];
    yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(projection),
            recoverDelegatedTask: () => Effect.void,
            dispatch: (command) => {
              if (command.type === "message.dispatch") dispatches.push(command);
              return Effect.succeed({ storedEvents: [] } as never);
            },
          }),
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
        ),
      ),
    );
    return dispatches;
  });

const continuationTexts = (projection: OrchestrationV2ThreadProjection) =>
  continuationDispatches(projection).pipe(
    Effect.map((dispatches) => dispatches.map((command) => command.text)),
  );

const cutMidTurn = (extra: Record<string, unknown> = {}) => {
  const base = makeProjection();
  return {
    ...base,
    runs: [
      {
        ...base.runs[0]!,
        status: "cancelled",
        userMessageId: MessageId.make("message:user"),
        ...extra,
      },
    ],
    providerTurns: [{ ...base.providerTurns[0]!, status: "cancelled" }],
  } as unknown as OrchestrationV2ThreadProjection;
};

const queuedFollowUp = {
  id: RunId.make("run:queued"),
  ordinal: 2,
  providerInstanceId: instanceId,
  providerThreadId,
  status: "queued",
  queueHeld: true,
};

it.effect("continues a cut run past queued follow-ups, which stay held", () =>
  Effect.gen(function* () {
    const live = makeProjection();
    assert.equal(
      restartContinuationRun(
        {
          ...live,
          runs: [...live.runs, queuedFollowUp],
        } as unknown as OrchestrationV2ThreadProjection,
        now,
      )?.id,
      runId,
    );
    const cut = cutMidTurn();
    const texts = yield* continuationTexts({
      ...cut,
      runs: [...cut.runs, queuedFollowUp],
    } as unknown as OrchestrationV2ThreadProjection);
    assert.deepEqual(texts, ["Continue where you left off."]);
  }),
);

it.effect("continues a resumed queued run that ran after an earlier continuation", () =>
  Effect.gen(function* () {
    // The continuation (ordinal 3) ran ahead of the held queue, then the user
    // resumed the queued run (ordinal 1 here) and the server restarted again.
    const finishedContinuation = {
      id: RunId.make("run:earlier-continuation"),
      ordinal: 3,
      providerInstanceId: instanceId,
      providerThreadId,
      status: "completed",
      completedAt: DateTime.makeUnsafe("2026-10-03T10:00:00.000Z"),
    };
    const live = makeProjection();
    assert.equal(
      restartContinuationRun(
        {
          ...live,
          runs: [...live.runs, finishedContinuation],
        } as unknown as OrchestrationV2ThreadProjection,
        now,
      )?.id,
      runId,
    );
    const cut = cutMidTurn({ completedAt: DateTime.makeUnsafe("2026-10-03T10:05:00.000Z") });
    const texts = yield* continuationTexts({
      ...cut,
      runs: [...cut.runs, finishedContinuation],
    } as unknown as OrchestrationV2ThreadProjection);
    assert.deepEqual(texts, ["Continue where you left off."]);
  }),
);

it.effect("does not continue a run the user asked to stop before the restart", () =>
  Effect.gen(function* () {
    const texts = yield* continuationTexts({
      ...cutMidTurn(),
      turnItems: [{ id: "turn-item:interrupt", runId, type: "run_interrupt_request" }],
    } as unknown as OrchestrationV2ThreadProjection);
    assert.deepEqual(texts, []);
  }),
);

it.effect("does not continue a cut /compact or /logout turn", () =>
  Effect.gen(function* () {
    // Compaction with focus instructions is still compaction.
    for (const text of ["/compact", " /LOGOUT ", "/compact keep the API notes"]) {
      const texts = yield* continuationTexts({
        ...cutMidTurn(),
        messages: [{ id: MessageId.make("message:user"), text, attachments: [] }],
      } as unknown as OrchestrationV2ThreadProjection);
      assert.deepEqual(texts, [], text);
    }
    const texts = yield* continuationTexts({
      ...cutMidTurn(),
      messages: [{ id: MessageId.make("message:user"), text: "/compacting", attachments: [] }],
    } as unknown as OrchestrationV2ThreadProjection);
    assert.lengthOf(texts, 1);
  }),
);

it.effect("tells a turn cut mid-way about the background work it lost", () =>
  Effect.gen(function* () {
    const texts = yield* continuationTexts(
      cutMidTurn({
        restartCancelledBackgroundWork: [{ kind: "subagent", label: "Background reviewer" }],
      }),
    );
    assert.lengthOf(texts, 1);
    assert.include(texts[0]!, "Background reviewer");
    assert.isTrue(texts[0]!.endsWith("Continue where you left off."));
  }),
);

it.effect("shows a continuation as a SSHCode notice whose detail is the prompt", () =>
  Effect.gen(function* () {
    const [resumed] = yield* continuationDispatches(cutMidTurn());
    assert.deepEqual(resumed?.notification, {
      source: { kind: "system" },
      outcome: "updated",
      summary: "SSHCode restarted and resumed this turn",
      detail: "Continue where you left off.",
    });
  }),
);

it.effect(
  "carries the note forward when its continuation was cut before reaching the provider",
  () =>
    Effect.gen(function* () {
      const base = makeProjection();
      const original = {
        ...base.runs[0]!,
        id: RunId.make("run:original"),
        status: "completed",
        activeAttemptId: RunAttemptId.make("attempt:original"),
        restartCancelledBackgroundWork: [{ kind: "shell", label: "sleep 25 && echo DONE" }],
      };
      const projection = {
        ...base,
        runs: [
          original,
          {
            ...base.runs[0]!,
            ordinal: 2,
            status: "cancelled",
            restartContinuationOfRunId: original.id,
          },
        ],
        // The original turn settled; the continuation's attempt never started one.
        providerTurns: [
          {
            ...base.providerTurns[0]!,
            runAttemptId: original.activeAttemptId,
            status: "completed",
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const texts = yield* continuationTexts(projection);
      assert.lengthOf(texts, 1);
      assert.include(texts[0]!, "sleep 25 && echo DONE");
      assert.notInclude(texts[0]!, "Continue where");
    }),
);

it.effect("prepares later threads' continuations when one thread fails", () =>
  Effect.gen(function* () {
    const brokenThreadId = ThreadId.make("thread:broken");
    const writes: Parameters<EventSink.EventSinkV2["Service"]["writeWithEffects"]>[0][] = [];
    const recovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([brokenThreadId, threadId]),
            getRuntimeRecoveryProjection: (id) =>
              id === brokenThreadId
                ? Effect.fail(
                    new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId: id }),
                  )
                : Effect.succeed(makeProjection()),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            writeWithEffects: (input) =>
              Effect.sync(() => {
                writes.push(input);
                return [];
              }),
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({}),
          Layer.mock(EffectOutbox.EffectOutboxV2)({}),
        ),
      ),
    );
    yield* recovery.prepareForShutdown;
    assert.deepEqual(
      writes.map((write) => write.effects[0]?.request),
      [{ type: "provider-runtime.continue", sourceRunId: runId }],
    );
  }),
);

it.effect("stops continuing after three automatic restart continuations in a row", () =>
  Effect.gen(function* () {
    const first = RunId.make("run:first-continuation");
    const second = RunId.make("run:second-continuation");
    const cut = cutMidTurn({ restartContinuationOfRunId: second });
    const withTwoLinks = {
      ...cut,
      runs: [
        ...cut.runs,
        { ...cut.runs[0]!, id: second, restartContinuationOfRunId: first },
        { ...cut.runs[0]!, id: first, restartContinuationOfRunId: undefined },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    assert.lengthOf(yield* continuationTexts(withTwoLinks), 1);

    const withThreeLinks = {
      ...withTwoLinks,
      runs: withTwoLinks.runs.map((run) =>
        run.id === first ? { ...run, restartContinuationOfRunId: RunId.make("run:root") } : run,
      ),
    } as unknown as OrchestrationV2ThreadProjection;
    assert.lengthOf(yield* continuationTexts(withThreeLinks), 0);
    const afterAccountMove = {
      ...withThreeLinks,
      runs: withThreeLinks.runs.map((run) =>
        run.id === first
          ? { ...run, providerInstanceId: ProviderInstanceId.make("other-account") }
          : run,
      ),
    };
    assert.lengthOf(yield* continuationTexts(afterAccountMove), 1);
  }),
);

it.effect.each([
  ["user_input", "pending", "live", false],
  ["user_input", "expired", "not_resumable", false],
  ["user_input", "cancelled", "not_resumable", false],
  ["command", "pending", "live", false],
  ["command", "expired", "not_resumable", false],
  ["user_input", "resolved", "live", true],
  ["command", "cancelled", "live", true],
  ["user_input", "pending", "message", true],
  ["dynamic_tool_call", "pending", "live", true],
  ["auth_refresh", "pending", "live", true],
] as const)(
  "a %s request that is %s with %s capability allows continuation: %s",
  ([kind, status, capability, shouldContinue]) =>
    Effect.gen(function* () {
      const base = makeProjection();
      const runtimeRequests = [
        {
          id: RuntimeRequestId.make("request:restart"),
          nodeId: NodeId.make("node:restart-question"),
          providerTurnId: base.providerTurns[0]!.id,
          kind,
          status,
          responseCapability:
            capability === "live"
              ? { type: capability, providerSessionId: sessionId }
              : capability === "not_resumable"
                ? { type: capability, reason: "The server restarted." }
                : { type: capability },
        },
      ];
      const live = { ...base, runtimeRequests } as unknown as OrchestrationV2ThreadProjection;
      assert.equal(restartContinuationRun(live, now) !== undefined, shouldContinue);
      const cut = {
        ...cutMidTurn(),
        runtimeRequests,
      } as unknown as OrchestrationV2ThreadProjection;
      assert.lengthOf(yield* continuationTexts(cut), shouldContinue ? 1 : 0);
    }),
);

it.effect("does not wake a snoozed or settled thread, but continues once a snooze elapsed", () =>
  Effect.gen(function* () {
    const live = makeProjection();
    for (const held of [
      { snoozedUntil: DateTime.add(now, { days: 1 }) },
      { settledOverride: "settled" as const },
    ]) {
      const thread = { ...live.thread, ...held };
      assert.isUndefined(restartContinuationRun({ ...live, thread }, now));
      assert.deepEqual(yield* continuationTexts({ ...cutMidTurn(), thread }), []);
    }
    const thread = { ...live.thread, snoozedUntil: DateTime.subtract(now, { minutes: 1 }) };
    assert.equal(restartContinuationRun({ ...live, thread }, now)?.id, runId);
  }),
);

it.effect("continues work with a pending secret card after restart", () =>
  Effect.gen(function* () {
    const secret = {
      type: "secret_request",
      runId,
      secretStatus: "pending",
      completedAt: null,
    } as never;
    assert.equal(
      restartContinuationRun({ ...makeProjection(), turnItems: [secret] }, now)?.id,
      runId,
    );
    assert.lengthOf(yield* continuationTexts({ ...cutMidTurn(), turnItems: [secret] }), 1);
  }),
);

it.effect.each(["completed", "failed", "interrupted"] as const)(
  "does not continue when the provider turn %s before the app run settled",
  (status) =>
    Effect.gen(function* () {
      const cut = cutMidTurn();
      assert.deepEqual(
        yield* continuationTexts({
          ...cut,
          providerTurns: [{ ...cut.providerTurns[0]!, status }],
        }),
        [],
      );
    }),
);

// Shaped on a real restart: a monitor wake ran a long command; a steer with a
// screenshot had been answered, then a question-card answer arrived after the
// last assistant output and the restart cut the run before the next step.
const steer = (id: string, ordinal: number) => ({
  id: `turn-item:message:${id}`,
  runId,
  type: "user_message",
  inputIntent: "steer",
  messageId: MessageId.make(id),
  ordinal,
  status: "completed",
  attachments: [],
});
const screenshot = {
  type: "image",
  id: "thread-restart-screenshot",
  name: "Screenshot.png",
  mimeType: "image/png",
  sizeBytes: 997672,
};
const midTurnItems = [
  { ...steer("message:read-steer", 38), attachments: [screenshot] },
  { id: "turn-item:reply", runId, type: "assistant_message", ordinal: 85, status: "completed" },
  { id: "turn-item:command", runId, type: "command_execution", ordinal: 86, status: "cancelled" },
  {
    ...steer("async-answer:runtime-request:ask-user:restart", 87),
    inputIntent: "promoted_queued_to_steer",
  },
  { ...steer("message:unread-steer", 88), attachments: [screenshot] },
];
const midTurnMessages = [
  { id: MessageId.make("message:read-steer"), text: "already seen", attachments: [screenshot] },
  {
    id: MessageId.make("async-answer:runtime-request:ask-user:restart"),
    text: "try the other model",
    attachments: [],
  },
  {
    id: MessageId.make("message:unread-steer"),
    text: "look at @screenshot too",
    context: {
      version: 1,
      records: [{ version: 1, contextId: "image_restart", kind: "image" }],
    },
    attachments: [screenshot],
  },
];

it.effect("re-sends mid-turn messages that arrived after the cut run's last output", () =>
  Effect.gen(function* () {
    const [resumed] = yield* continuationDispatches({
      ...cutMidTurn(),
      turnItems: midTurnItems,
      messages: midTurnMessages,
    } as unknown as OrchestrationV2ThreadProjection);
    assert.isDefined(resumed);
    assert.include(resumed!.text, "try the other model");
    assert.include(resumed!.text, "look at @screenshot too");
    assert.include(resumed!.text, "possibly unread");
    assert.notInclude(resumed!.text, "already seen");
    assert.isTrue(resumed!.text.indexOf("try the other") < resumed!.text.indexOf("look at"));
    assert.isTrue(resumed!.text.endsWith("Continue where you left off."));
    assert.deepEqual(resumed!.attachments, [screenshot]);
    assert.deepEqual(
      resumed!.context?.records.map((record) => record.contextId),
      ["image_restart"],
    );
    assert.equal(resumed!.notification?.detail, resumed!.text);
  }),
);

it.effect("re-sends them again when the continuation carrying them was cut before any output", () =>
  Effect.gen(function* () {
    const cut = cutMidTurn();
    const original = { ...cut.runs[0]!, id: RunId.make("run:original") };
    const projection = {
      ...cut,
      runs: [original, { ...cut.runs[0]!, ordinal: 2, restartContinuationOfRunId: original.id }],
      turnItems: midTurnItems.map((item) => ({ ...item, runId: original.id })),
      messages: midTurnMessages,
    } as unknown as OrchestrationV2ThreadProjection;
    const [resumed] = yield* continuationDispatches(projection);
    assert.include(resumed?.text ?? "", "try the other model");
    assert.notInclude(resumed?.text ?? "", "already seen");
  }),
);

// Shaped on a real restart: a delegated child's first run was still running
// its worktree setup script, so no provider turn or native thread existed yet.
const cutWhilePreparing = (status: "preparing" | "cancelled") => {
  const base = makeProjection();
  return {
    ...base,
    runs: [
      {
        ...base.runs[0]!,
        status,
        startedAt: null,
        userMessageId: MessageId.make("message:delegated-task"),
        delegatedTaskId: NodeId.make("node:delegated-task"),
        workspacePreparation: { type: "worktree", baseRef: "c3ab362681", startFromOrigin: false },
      },
    ],
    providerThreads: [
      {
        ...base.providerThreads[0]!,
        nativeThreadRef: null,
        providerSessionId: null,
        status: "idle",
      },
    ],
    providerSessions: [],
    providerTurns: [],
    turnItems: [
      {
        id: "turn-item:workspace-preparation",
        runId,
        type: "command_execution",
        input: "Preparing workspace",
        status: status === "preparing" ? "running" : "cancelled",
        ordinal: 2,
      },
    ],
    messages: [
      {
        id: MessageId.make("message:delegated-task"),
        text: "Goal: fix the failing check",
        context: { version: 1, records: [] },
        attachments: [screenshot],
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
};

it("restarts a run the restart cut before its provider turn started", () => {
  for (const status of ["preparing", "starting", "running"] as const) {
    const live = cutWhilePreparing("preparing");
    assert.equal(
      restartContinuationRun({ ...live, runs: [{ ...live.runs[0]!, status }] }, now)?.id,
      runId,
      status,
    );
  }
  const live = cutWhilePreparing("preparing");
  // A started provider turn means the provider has the prompt: no fresh start.
  assert.isUndefined(
    restartContinuationRun(
      {
        ...live,
        providerTurns: [{ ...makeProjection().providerTurns[0]!, status: "running" }],
      } as unknown as OrchestrationV2ThreadProjection,
      now,
    ),
  );
});

it.effect("starts a cut run again from its original message, preparing its workspace", () =>
  Effect.gen(function* () {
    const [restarted] = yield* continuationDispatches(cutWhilePreparing("cancelled"));
    assert.isDefined(restarted);
    assert.equal(restarted!.text, "Goal: fix the failing check");
    assert.deepEqual(restarted!.attachments, [screenshot]);
    assert.deepEqual(restarted!.context, { version: 1, records: [] });
    assert.equal(restarted!.restartContinuationOfRunId, runId);
    assert.deepEqual(restarted!.dispatchMode, {
      type: "defer_start",
      workspaceStrategy: { type: "worktree", baseRef: "c3ab362681", startFromOrigin: false },
    });
  }),
);

it.effect("starts a cut run again without preparation once its workspace was ready", () =>
  Effect.gen(function* () {
    const cut = cutWhilePreparing("cancelled");
    const [restarted] = yield* continuationDispatches({
      ...cut,
      turnItems: cut.turnItems.map((item) => ({ ...item, status: "completed" })),
    } as unknown as OrchestrationV2ThreadProjection);
    assert.equal(restarted?.text, "Goal: fix the failing check");
    assert.deepEqual(restarted?.dispatchMode, { type: "start_immediately" });
  }),
);

it.effect("does not start a cut run again when the user or parent stopped it", () =>
  Effect.gen(function* () {
    const cut = cutWhilePreparing("cancelled");
    const texts = yield* continuationTexts({
      ...cut,
      turnItems: [
        ...cut.turnItems,
        { id: "turn-item:interrupt", runId, type: "run_interrupt_request" },
      ],
    } as unknown as OrchestrationV2ThreadProjection);
    assert.deepEqual(texts, []);
    const interrupted = yield* continuationTexts({
      ...cut,
      runs: [{ ...cut.runs[0]!, status: "interrupted" }],
    } as unknown as OrchestrationV2ThreadProjection);
    assert.deepEqual(interrupted, []);
  }),
);

it.effect("starts it again from the same message when a second restart cuts that start", () =>
  Effect.gen(function* () {
    const cut = cutWhilePreparing("cancelled");
    const original = { ...cut.runs[0]!, id: RunId.make("run:first-start") };
    const restartMessageId = MessageId.make("message:restart-continuation:run:first-start");
    const [again] = yield* continuationDispatches({
      ...cut,
      runs: [
        original,
        {
          ...cut.runs[0]!,
          ordinal: 2,
          userMessageId: restartMessageId,
          restartContinuationOfRunId: original.id,
        },
      ],
      messages: [{ ...cut.messages[0]!, id: restartMessageId }],
    } as unknown as OrchestrationV2ThreadProjection);
    assert.equal(again?.text, "Goal: fix the failing check");
    assert.equal(again?.dispatchMode.type, "defer_start");
  }),
);
