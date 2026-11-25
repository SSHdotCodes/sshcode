import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EventId,
  NodeId,
  RunId,
  MessageId,
  type WorkflowContextRecord,
  ProviderDriverKind,
  RuntimeRequestId,
  ProviderSessionId,
  WorkflowNodeId,
  WorkflowEdgeId,
  type OrchestrationV2Subagent,
  ThreadId,
  WorkflowId,
  WorkflowRunId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ServerCommand,
  type WorkflowsState,
} from "@t3tools/contracts";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import * as PubSub from "effect/PubSub";
import * as Rankings from "../subagentRankings/SubagentRankings.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { workflowsBetaEnabled } from "./workflowsBeta.ts";
import * as ServerConfig from "../config.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Folders from "../project/ManagedProjectFolders.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Generation from "../textGeneration/TextGeneration.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TestClock from "effect/testing/TestClock";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import * as Workflows from "./WorkflowsService.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import { catalog, delegationResult, runFixture, selection, workflowFixture } from "./fixtures.ts";
import { parseWorkflowCompile, workflowCompilePrompt } from "./compile.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "workflows-test-" }).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const snapshot = (service: Workflows.WorkflowsService["Service"]) =>
  service.subscribe().pipe(Stream.runHead, Effect.map(Option.getOrThrow));
function harness(
  outputs: string[] = [],
  events: Threads.ThreadManagementService["Service"]["streamDomainEvents"] = Stream.never,
  settingsLayer = ServerSettings.layerTest({ workflowsBeta: true }),
  extra: ReadonlyArray<Layer.Layer<Rankings.SubagentRankings>> = [],
  store?: ProjectionStore.ProjectionStoreV2["Service"],
) {
  const recordReads: ThreadId[] = [];
  const dispatched: OrchestrationV2ServerCommand[] = [];
  const launches: Launch.ThreadLaunchInput[] = [],
    interrupted: ThreadId[] = [],
    prompts: string[] = [];
  const interruptFailures = new Set<ThreadId>();
  const projections = new Map<ThreadId, OrchestrationV2ThreadProjection>();
  const getProjection = (id: ThreadId) =>
    projections.get(id) ?? idleThreadProjection(liveThreadShell(id));
  const dependencies = Layer.mergeAll(
    Layer.mock(Threads.ThreadManagementService)({
      hasReceipt: () => Effect.succeed(false),
      dispatch: (input) =>
        Effect.sync(() => {
          dispatched.push(input);
          if (input.type === "delegated_task.request") {
            const child = derive.delegatedTaskThread({ commandId: input.commandId });
            const task = taskProjection(input.parentThreadId, child);
            const parent = getProjection(input.parentThreadId);
            projections.set(input.parentThreadId, {
              ...parent,
              subagents: [...parent.subagents.filter((t) => t.id !== task.id), task],
            });
            projections.set(child, {
              ...getProjection(child),
              runs: [runProjection(child, "running")],
            });
            return {
              storedEvents: [
                {
                  sequence: 1,
                  commandId: input.commandId,
                  event: {
                    id: EventId.make(`event-${child}`),
                    type: "subagent.updated" as const,
                    threadId: input.parentThreadId,
                    payload: task,
                    occurredAt: task.updatedAt,
                  },
                },
              ],
              sequence: 1,
            };
          }
          return { storedEvents: [], sequence: 0 };
        }),
      getThreadProjection: (id) =>
        store
          ? store
              .getThreadProjection(id)
              .pipe(
                Effect.mapError(
                  (cause) => new OrchestratorProjectionError({ threadId: id, cause }),
                ),
              )
          : Effect.succeed(getProjection(id)),
      getThreadShell: (id) => Effect.succeed(projections.has(id) ? liveThreadShell(id) : null),
      getThreadRecords: (id, fields, filter) =>
        store
          ? store
              .getThreadRecords(id, fields, filter)
              .pipe(
                Effect.mapError(
                  (cause) => new OrchestratorProjectionError({ threadId: id, cause }),
                ),
              )
          : Effect.sync(() => {
              recordReads.push(id);
              return getProjection(id);
            }),
      streamDomainEvents: events,
      interruptThread: (input) =>
        Effect.suspend(() => {
          if (interruptFailures.has(input.threadId))
            return Effect.fail(
              new Threads.ThreadManagementThreadNotInterruptibleError({
                threadId: input.threadId,
                runId: RunId.make("blocked-stop"),
              }),
            );
          return Effect.sync(() => {
            interrupted.push(input.threadId);
            return { type: "no_active_run" as const };
          });
        }),
    }),
    Layer.mock(Launch.ThreadLaunchService)({
      launch: (input) =>
        Effect.sync(() => {
          launches.push(input);
          return {
            threadId: input.threadId!,
            projection: getProjection(input.threadId!),
            resumed: false,
          };
        }),
    }),
    Layer.mock(Folders.ManagedProjectFolders)({
      namedProjectsRoot: "",
      scratchRoot: Effect.succeed(Option.some("/test/scratch")),
      ensureScratchProject: Effect.succeed({
        projectId: liveThreadShell(ThreadId.make("any")).projectId,
      }),
    }),
    Layer.mock(Providers.ProviderRegistry)({ getProviders: Effect.succeed(catalog) }),
    settingsLayer,
    ...extra,
    Layer.mock(Generation.TextGeneration)({
      rewriteProse: (input) =>
        Effect.sync(() => {
          prompts.push(input.prompt);
          return { output: outputs.shift() ?? "invalid" };
        }),
    }),
  );
  return {
    open: Workflows.WorkflowsService.pipe(
      Effect.provide(Workflows.layer.pipe(Layer.provide(dependencies))),
    ),
    /** Lives for the test's scope, so background work (naming) keeps running. */
    openScoped: Layer.build(Workflows.layer.pipe(Layer.provide(dependencies))).pipe(
      Effect.map((context) => Context.get(context, Workflows.WorkflowsService)),
    ),
    recordReads,
    launches,
    dispatched,
    interrupted,
    interruptFailures,
    prompts,
    projections,
  };
}

const testTime = DateTime.makeUnsafe("2026-11-06T12:00:00.000Z");
function runProjection(
  id: ThreadId,
  status: OrchestrationV2ThreadProjection["runs"][number]["status"],
) {
  return {
    id: RunId.make(`run-${id}`),
    threadId: id,
    ordinal: 1,
    providerInstanceId: selection.instanceId,
    modelSelection: selection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message-${id}`),
    rootNodeId: NodeId.make(`root-${id}`),
    activeAttemptId: null,
    status,
    requestedAt: testTime,
    startedAt: testTime,
    completedAt: ["completed", "failed", "interrupted", "cancelled"].includes(status)
      ? testTime
      : null,
    checkpointId: null,
    contextHandoffId: null,
  } satisfies OrchestrationV2ThreadProjection["runs"][number];
}
function taskProjection(
  parent: ThreadId,
  child: ThreadId,
  status: OrchestrationV2Subagent["status"] = "running",
): OrchestrationV2Subagent {
  return {
    id: NodeId.make(`task-${child}`),
    threadId: parent,
    runId: RunId.make(`run-${parent}`),
    parentNodeId: NodeId.make(`root-${parent}`),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: selection.instanceId,
    providerThreadId: null,
    childThreadId: child,
    nativeTaskRef: null,
    prompt: "Original brief",
    title: "worker",
    model: selection.model,
    status,
    result: status === "completed" ? "Done" : null,
    startedAt: testTime,
    completedAt: ["completed", "failed", "interrupted", "cancelled"].includes(status)
      ? testTime
      : null,
    updatedAt: testTime,
  };
}

describe("WorkflowsService", () => {
  it.effect(
    "compiles compact text with the live Terra, retries malformed output once, and preserves scene positions",
    () =>
      Effect.gen(function* () {
        const workflow = workflowFixture(),
          result = { workflow, summary: "Resolved", issues: [] };
        const h = harness([
            JSON.stringify({
              ...result,
              workflow: {
                ...workflow,
                nodes: workflow.nodes.map((n) =>
                  n.kind === "agent" ? { ...n, count: { kind: "exact", n: 17 } } : n,
                ),
              },
            }),
            `\`\`\`json\n${JSON.stringify(result)}\n\`\`\``,
          ]),
          service = yield* h.open;
        const parsed = yield* service.compile({ workflow });
        expect(parsed.workflow).toEqual(workflow);
        expect(h.prompts).toHaveLength(2);
        expect(h.prompts[1]).toContain("Previous output was invalid");
        expect(h.prompts[0]).not.toContain('"x":400');
        expect(h.prompts[0]).toContain(selection.model);
        const invalid = yield* service.compile({ workflow }).pipe(Effect.result);
        expect(invalid._tag).toBe("Failure");
        expect(h.prompts).toHaveLength(4);
        expect(
          (yield* parseWorkflowCompile(
            JSON.stringify({
              ...result,
              workflow: {
                ...workflow,
                nodes: workflow.nodes.map((n) =>
                  n.kind === "agent" ? { ...n, model: { ...selection, model: "invented" } } : n,
                ),
              },
            }),
            { workflow },
            catalog,
          ).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          workflowCompilePrompt(
            {
              workflow,
              unboundArrows: [
                {
                  id: workflow.edges[0]!.id,
                  from: { x: 290, y: 100 },
                  to: { x: 401, y: 300 },
                  kind: "delegates",
                },
              ],
            },
            catalog,
          ),
        ).not.toContain('"from":{"x"');
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "starts dedicated leads and existing-chat leads, snapshots the graph and injects only the lead's compact plan",
    () =>
      Effect.gen(function* () {
        const h = harness(),
          service = yield* h.open,
          workflow = workflowFixture();
        yield* service.mutate({ type: "save", workflow });
        const first = yield* service.start({ workflowId: workflow.id, task: "Build it" });
        const chat = ThreadId.make("existing"),
          projection = idleThreadProjection(liveThreadShell(chat));
        h.projections.set(chat, {
          ...projection,
          thread: {
            ...projection.thread,
            modelSelection: { ...selection, model: "my-chat-model" },
          },
        });
        const second = yield* service.start({
          workflowId: workflow.id,
          task: "Use this chat",
          chatThreadId: chat,
        });
        const state = yield* snapshot(service);
        expect(state.runs[0]).toMatchObject({
          origin: "chat",
          leadThreadId: chat,
          snapshot: {
            nodes: [
              expect.objectContaining({ model: { ...selection, model: "my-chat-model" } }),
              expect.anything(),
              expect.anything(),
            ],
          },
        });
        expect(h.launches.map((l) => l.creationSource)).toEqual(["workflows"]);
        expect(h.launches[0]!.modelSelection).toEqual(selection);
        expect(h.dispatched[0]).toMatchObject({
          type: "message.dispatch",
          threadId: chat,
          modelSelection: { model: "my-chat-model" },
          context: { records: [expect.objectContaining({ kind: "workflow" })] },
        });
        const originalTurn = yield* service.delegate(
          chat,
          "before-workflow",
          { task: "Previous turn", target: { model: "unrelated-model" } },
          selection,
          () => Effect.succeed(delegationResult(ThreadId.make("ordinary-child"))),
        );
        expect(originalTurn.childThreadId).toBe("ordinary-child");
        const sent = h.dispatched[0]!;
        const workflowTurn = yield* service
          .delegate(
            chat,
            "workflow-turn",
            { task: "Workflow turn", target: { model: "unrelated-model" } },
            selection,
            () => Effect.succeed(delegationResult(ThreadId.make("should-not-start"))),
            sent.type === "message.dispatch" ? sent.context : undefined,
          )
          .pipe(Effect.result);
        expect(workflowTurn._tag).toBe("Failure");
        const message = h.launches[0]!.initialMessage!;
        const envelope = projectComposerContextForProvider({
          text: message.text,
          records: message.context!.records,
        });
        expect(envelope).toContain("worker brief");
        expect(envelope).not.toContain("helper brief");
        yield* service.mutate({ type: "save", workflow: { ...workflow, name: "Changed" } });
        expect((yield* snapshot(service)).runs[1]!.snapshot.name).toBe("Test");
        expect(first.leadThreadId).not.toBe(second.leadThreadId);
        expect(
          (yield* service
            .start({ workflowId: workflow.id, task: "Duplicate", chatThreadId: chat })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("checks an existing chat's placement without reading its transcript", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("workflow:metadata-only");
      const thread = {
        ...idleThreadProjection(liveThreadShell(threadId)).thread,
        worktreePath: "/test/isolated",
      };
      yield* store.apply({
        type: "thread.created",
        id: EventId.make("workflow:metadata-created"),
        threadId,
        occurredAt: thread.createdAt,
        payload: thread,
      });
      yield* sql`INSERT INTO orchestration_v2_projection_nodes
        (node_id, thread_id, root_node_id, kind, status, payload_json)
        VALUES ('unreadable-history', ${threadId}, 'unreadable-history', 'tool_call', 'completed', '{}')`;
      const h = harness(
        [],
        Stream.never,
        ServerSettings.layerTest({ workflowsBeta: true }),
        [],
        store,
      );
      const service = yield* h.open;
      const workflow = workflowFixture();
      yield* service.mutate({ type: "save", workflow });
      const error = yield* service
        .start({ workflowId: workflow.id, task: "Work", chatThreadId: threadId })
        .pipe(Effect.flip);
      expect(error.message).toBe(
        "This chat uses a worktree. Start the workflow from a shared chat.",
      );
      expect(h.launches).toEqual([]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.merge(
          testLayer,
          ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
        ),
      ),
    ),
  );

  it.effect("rejects unsupported lead placement on both start paths before launching", () =>
    Effect.gen(function* () {
      const h = harness(),
        service = yield* h.open;
      for (const placement of [{ isolation: "worktree" as const }]) {
        const workflow = workflowFixture();
        yield* service.mutate({
          type: "save",
          workflow: {
            ...workflow,
            nodes: workflow.nodes.map((n) =>
              n.id === workflow.rootNodeId ? { ...n, ...placement } : n,
            ),
          },
        });
        const result = yield* service
          .start({ workflowId: workflow.id, task: "Build" })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure).toMatchObject({
            reason: "invalid",
            issues: [
              expect.objectContaining({
                nodeId: workflow.rootNodeId,
                message: expect.stringContaining("not supported"),
              }),
            ],
          });
        let spawned = false;
        const child = yield* service
          .startChild(
            {
              workflowId: workflow.id,
              task: "Build",
              key: "invalid",
              leadThreadId: ThreadId.make("never"),
            },
            () =>
              Effect.sync(() => {
                spawned = true;
                return delegationResult(ThreadId.make("never"));
              }),
          )
          .pipe(Effect.result);
        expect(child._tag).toBe("Failure");
        expect(spawned).toBe(false);
      }
      expect(h.launches).toHaveLength(0);
      expect((yield* snapshot(service)).runs).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "persists lead ownership before spawning and resumes the same reserved start after a lost response",
    () =>
      Effect.gen(function* () {
        const h = harness(),
          service = yield* h.open,
          workflow = workflowFixture();
        yield* service.mutate({ type: "save", workflow });
        const input = {
          workflowId: workflow.id,
          task: "Build",
          key: "caller:start-one",
          leadThreadId: ThreadId.make("reserved-lead"),
        };
        const first = yield* service
          .startChild(input, () =>
            Effect.gen(function* () {
              const saved = (yield* snapshot(service)).runs[0]!;
              expect(saved.leadThreadId).toBe(input.leadThreadId);
              const fs = yield* FileSystem.FileSystem,
                config = yield* ServerConfig.ServerConfig;
              expect(
                JSON.parse(yield* fs.readFileString(`${config.stateDir}/workflows.json`))
                  .activeRuns[0].leadThreadId,
              ).toBe(input.leadThreadId);
              const denied = yield* service
                .delegate(
                  input.leadThreadId,
                  "early",
                  { task: "Off plan", target: { model: "wrong" } },
                  selection,
                  () => Effect.succeed(delegationResult(ThreadId.make("forbidden"))),
                )
                .pipe(Effect.result);
              expect(denied._tag).toBe("Failure");
              return yield* Effect.fail("lost response");
            }),
          )
          .pipe(Effect.result);
        expect(first._tag).toBe("Failure");
        const runId = (yield* snapshot(service)).runs[0]!.id;
        const restored = yield* h.open;
        const replay = yield* restored.startChild(input, () =>
          Effect.succeed(delegationResult(input.leadThreadId)),
        );
        expect(replay.runId).toBe(runId);
        expect((yield* snapshot(restored)).runs).toHaveLength(1);
        expect(
          (yield* restored
            .startChild({ ...input, task: "Different" }, () =>
              Effect.succeed(delegationResult(input.leadThreadId)),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("cancels a reserved start with no thread and refuses to release it on retry", () =>
    Effect.gen(function* () {
      const h = harness(),
        service = yield* h.open,
        workflow = workflowFixture();
      yield* service.mutate({ type: "save", workflow });
      const input = {
        workflowId: workflow.id,
        task: "Build",
        key: "cancel-reservation",
        leadThreadId: ThreadId.make("not-created"),
      };
      yield* service.startChild(input, () => Effect.fail("not dispatched")).pipe(Effect.result);
      const run = (yield* snapshot(service)).runs[0]!;
      yield* service.mutate({ type: "cancelRun", runId: run.id });
      expect((yield* snapshot(service)).runs[0]).toMatchObject({
        status: "cancelled",
        agents: [expect.objectContaining({ status: "cancelled" })],
      });
      let spawned = false;
      expect(
        (yield* service
          .startChild(input, () =>
            Effect.sync(() => {
              spawned = true;
              return delegationResult(input.leadThreadId);
            }),
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(spawned).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("does not spawn when the initial reservation cannot be saved", () =>
    Effect.gen(function* () {
      const h = harness(),
        service = yield* h.open,
        workflow = workflowFixture();
      yield* service.mutate({ type: "save", workflow });
      const fs = yield* FileSystem.FileSystem,
        config = yield* ServerConfig.ServerConfig;
      yield* fs.remove(`${config.stateDir}/workflows.json`);
      yield* fs.makeDirectory(`${config.stateDir}/workflows.json`);
      let spawned = false;
      const result = yield* service
        .startChild(
          {
            workflowId: workflow.id,
            task: "Build",
            key: "blocked",
            leadThreadId: ThreadId.make("blocked"),
          },
          () =>
            Effect.sync(() => {
              spawned = true;
              return delegationResult(ThreadId.make("blocked"));
            }),
        )
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(spawned).toBe(false);
      expect((yield* snapshot(service)).runs).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("starts an agent's run as its subagent and holds the lead to the drawn boxes", () =>
    Effect.gen(function* () {
      const h = harness(),
        service = yield* h.open,
        workflow = workflowFixture();
      yield* service.mutate({ type: "save", workflow });
      const spawned: Array<Parameters<Parameters<typeof service.startChild>[1]>[0]> = [];
      const lead = ThreadId.make("lead-child");
      const started = yield* service.startChild(
        { workflowId: workflow.id, task: "Ship it", key: "start", leadThreadId: lead },
        (input) =>
          Effect.sync(() => {
            spawned.push(input);
            return delegationResult(lead);
          }),
      );
      expect(spawned[0]).toMatchObject({
        mode: "async",
        target: { providerInstanceId: selection.instanceId, model: selection.model },
      });
      expect(spawned[0]!.task).toContain("Ship it");
      expect(spawned[0]!.task).toContain("worker brief");
      expect(h.launches).toHaveLength(0);
      const state = yield* snapshot(service);
      expect(state.runs[0]).toMatchObject({ id: started.runId, leadThreadId: lead });
      const offPlan = yield* service
        .delegate(
          lead,
          "off-plan",
          { task: "Anything", target: { model: "unrelated-model" } },
          selection,
          () => Effect.succeed(delegationResult(ThreadId.make("should-not-start"))),
        )
        .pipe(Effect.result);
      expect(offPlan._tag).toBe("Failure");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "records delegated slots, replays retries, updates nested status and progress, cancels every live thread, and restores state",
    () =>
      Effect.gen(function* () {
        const h = harness(),
          service = yield* h.open,
          workflow = workflowFixture();
        yield* service.mutate({ type: "save", workflow });
        const { leadThreadId, runId } = yield* service.start({
          workflowId: workflow.id,
          task: "Build",
        });
        const child = ThreadId.make("worker"),
          grandchild = ThreadId.make("helper");
        const execute = () =>
          Effect.succeed({
            taskId: NodeId.make("task"),
            childRunId: null,
            workState: "working" as const,
            providerInstanceId: selection.instanceId,
            model: selection.model,
            childThreadId: child,
            status: "running" as const,
          });
        yield* service.delegate(
          leadThreadId,
          "key",
          { task: "Work", target: { model: selection.model }, title: "worker" },
          selection,
          execute,
        );
        yield* service.delegate(leadThreadId, "key", { task: "Work" }, selection, execute);
        yield* service.delegate(
          child,
          "nested",
          { task: "Help", title: "helper", target: { model: selection.model } },
          selection,
          () =>
            Effect.succeed({
              taskId: NodeId.make("nested"),
              childRunId: null,
              workState: "working" as const,
              providerInstanceId: selection.instanceId,
              model: selection.model,
              childThreadId: grandchild,
              status: "waiting" as const,
              hasPendingQuestion: true as const,
            }),
        );
        expect((yield* snapshot(service)).runs[0]!.agents.map((a) => [a.nodeId, a.slot])).toEqual([
          ["lead", 0],
          ["worker", 0],
          ["helper", 0],
        ]);
        const restored = yield* h.open;
        expect((yield* snapshot(restored)).runs[0]!.id).toBe(runId);
        yield* service.mutate({ type: "cancelRun", runId });
        expect(new Set(h.interrupted)).toEqual(new Set([leadThreadId, child, grandchild]));
        expect((yield* snapshot(service)).runs[0]).toMatchObject({
          status: "cancelled",
          agents: [
            expect.objectContaining({ status: "cancelled" }),
            expect.objectContaining({ status: "cancelled" }),
            expect.objectContaining({ status: "cancelled" }),
          ],
        });
        yield* service.mutate({ type: "deleteRun", runId });
        expect((yield* snapshot(service)).runs).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("rejects concurrent count overflow and releases failed reservations", () =>
    Effect.gen(function* () {
      const h = harness(),
        service = yield* h.open,
        workflow = workflowFixture();
      yield* service.mutate({ type: "save", workflow });
      const { leadThreadId } = yield* service.start({ workflowId: workflow.id, task: "Work" });
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      const input = { task: "Work", target: { model: selection.model } };
      const pending = yield* service
        .delegate(leadThreadId, "one", input, selection, (_adjusted, record) =>
          Effect.gen(function* () {
            expect(record?.plan).not.toContain("lead brief");
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return delegationResult(ThreadId.make("first"));
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const overflow = yield* service
        .delegate(leadThreadId, "two", input, selection, () =>
          Effect.succeed(delegationResult(ThreadId.make("other"))),
        )
        .pipe(Effect.result);
      expect(overflow._tag).toBe("Failure");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(pending);
      const second = yield* service.start({ workflowId: workflow.id, task: "Again" });
      yield* service
        .delegate(second.leadThreadId, "fail", input, selection, () => Effect.fail("failed"))
        .pipe(Effect.result);
      yield* service.delegate(second.leadThreadId, "retry", input, selection, () =>
        Effect.succeed(delegationResult(ThreadId.make("retry"))),
      );
      expect((yield* snapshot(service)).runs[0]!.agents).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "streams waiting, running, progress and completion from persisted run and lineage records",
    () =>
      Effect.gen(function* () {
        const h = harness(),
          service = yield* h.open,
          workflow = workflowFixture();
        yield* service.mutate({ type: "save", workflow });
        const { leadThreadId } = yield* service.start({ workflowId: workflow.id, task: "Work" });
        const child = ThreadId.make("tracking-worker");
        yield* service.delegate(
          leadThreadId,
          "tracking",
          { task: "Work", target: { model: selection.model } },
          selection,
          () => Effect.succeed(delegationResult(child, "waiting")),
        );
        const base = idleThreadProjection(liveThreadShell(leadThreadId));
        const time = DateTime.makeUnsafe("2026-11-06T12:00:00.000Z");
        const run: OrchestrationV2ThreadProjection["runs"][number] = {
          id: RunId.make("tracked"),
          threadId: leadThreadId,
          ordinal: 1,
          providerInstanceId: selection.instanceId,
          modelSelection: selection,
          providerThreadId: null,
          userMessageId: MessageId.make("tracked"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "waiting",
          requestedAt: time,
          startedAt: time,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        };
        const task: OrchestrationV2ThreadProjection["subagents"][number] = {
          id: NodeId.make("tracking-task"),
          threadId: leadThreadId,
          runId: run.id,
          parentNodeId: NodeId.make("tracking-parent"),
          origin: "app_owned",
          createdBy: "agent",
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: selection.instanceId,
          providerThreadId: null,
          childThreadId: child,
          nativeTaskRef: null,
          prompt: "Work",
          title: "worker",
          model: selection.model,
          status: "waiting",
          progress: "Reading the files",
          result: null,
          startedAt: time,
          completedAt: null,
          updatedAt: time,
        };
        h.projections.set(leadThreadId, { ...base, runs: [run], subagents: [task] });
        yield* service.refresh;
        expect((yield* snapshot(service)).runs[0]!.status).toBe("waiting");
        expect((yield* snapshot(service)).runs[0]!.agents[1]!.progress).toBe("Reading the files");
        h.projections.set(leadThreadId, {
          ...base,
          runs: [{ ...run, status: "running" }],
          subagents: [task],
        });
        yield* service.refresh;
        expect((yield* snapshot(service)).runs[0]!.status).toBe("running");
        // The lead ends its turn while its child works: the run stays open.
        h.projections.set(leadThreadId, {
          ...base,
          runs: [{ ...run, status: "completed", completedAt: time }],
          subagents: [{ ...task, status: "running" }],
        });
        yield* service.refresh;
        expect((yield* snapshot(service)).runs[0]).toMatchObject({
          status: "running",
          agents: [
            expect.objectContaining({ status: "waiting", completedAt: null }),
            expect.anything(),
          ],
        });
        // The child's turn ended too, but its own subagent still works.
        const childBase = idleThreadProjection(liveThreadShell(child));
        h.projections.set(child, {
          ...childBase,
          runs: [{ ...run, threadId: child, status: "completed", completedAt: time }],
          subagents: [{ ...task, threadId: child, childThreadId: ThreadId.make("grandchild") }],
        });
        h.projections.set(leadThreadId, {
          ...base,
          runs: [{ ...run, status: "completed", completedAt: time }],
          subagents: [{ ...task, status: "completed", completedAt: time }],
        });
        yield* service.refresh;
        expect((yield* snapshot(service)).runs[0]!.status).toBe("waiting");
        h.projections.delete(child);
        h.projections.set(leadThreadId, {
          ...base,
          runs: [{ ...run, status: "completed", completedAt: time }],
          subagents: [{ ...task, status: "completed", completedAt: time }],
        });
        const complete = yield* service.subscribe().pipe(
          Stream.filter((s) => s.runs[0]?.status === "completed"),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* service.refresh;
        const observed = yield* Fiber.join(complete);
        expect(Option.getOrThrow(observed).runs[0]!.agents[0]).toMatchObject({
          status: "completed",
          completedAt: "2026-11-06T12:00:00.000Z",
        });
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "names untitled and agent-saved workflows like chats, never a name the user typed",
    () =>
      Effect.gen(function* () {
        const h = harness(["**Fizzbuzz Relay Team.**", "Parser Review Crew"]),
          service = yield* h.openScoped;
        // Naming waits for edits to pause; let the forked wait start, then pass it.
        const pause = Effect.gen(function* () {
          for (let i = 0; i < 5; i++) yield* Effect.yieldNow;
          yield* TestClock.adjust("5 seconds");
          for (let i = 0; i < 5; i++) yield* Effect.yieldNow;
        });
        const untitled = { ...workflowFixture(), name: "Untitled workflow" };
        // Saving the new name writes a real file; wait for the state, not a fixed time.
        const named = (name: string) =>
          service.subscribe().pipe(
            Stream.map((state) => state.workflows.find((w) => w.name === name)),
            Stream.filter((w) => w !== undefined),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
            Effect.timeout("2 seconds"),
          );
        yield* service.mutate({ type: "save", workflow: untitled });
        yield* pause;
        const renamed = yield* named("Fizzbuzz Relay Team").pipe(TestClock.withLive);
        expect(h.prompts.at(-1)).toContain("Name this saved team of AI agents");
        // The user renames it: theirs from now on, even after more edits.
        yield* service.mutate({
          type: "save",
          workflow: { ...renamed, name: "My team", description: "x" },
        });
        yield* pause;
        expect((yield* snapshot(service)).workflows[0]!.name).toBe("My team");
        expect(h.prompts).toHaveLength(1);
        // An agent's new workflow: its long name is only a seed.
        const fromAgent = {
          ...workflowFixture(),
          id: WorkflowId.make("wf_agent"),
          name: "Opus lead with Sol managers and Haiku subagents",
        };
        yield* service.mutate({ type: "save", workflow: fromAgent });
        yield* service.agentSaved(fromAgent.id, undefined);
        yield* pause;
        expect((yield* named("Parser Review Crew").pipe(TestClock.withLive)).id).toBe(fromAgent.id);
        // An agent re-saving the user's workflow keeps the user's name.
        yield* service.agentSaved(untitled.id, "My team");
        yield* pause;
        expect(h.prompts).toHaveLength(2);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("cancels a child whose creation commits while cancellation is in flight", () =>
    Effect.gen(function* () {
      const h = harness(),
        service = yield* h.open,
        workflow = workflowFixture();
      yield* service.mutate({ type: "save", workflow });
      const { leadThreadId, runId } = yield* service.start({
        workflowId: workflow.id,
        task: "Work",
      });
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>(),
        child = ThreadId.make("late-child");
      const creating = yield* service
        .delegate(
          leadThreadId,
          "late",
          { task: "Work", target: { model: selection.model } },
          selection,
          () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return delegationResult(child);
            }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* service.mutate({ type: "cancelRun", runId });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(creating);
      expect(new Set(h.interrupted)).toEqual(new Set([leadThreadId, child]));
      expect(
        (yield* snapshot(service)).runs[0]!.agents.every((a) => a.status === "cancelled"),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("does not publish a state whose atomic write failed", () =>
    Effect.gen(function* () {
      const h = harness(),
        service = yield* h.open,
        fs = yield* FileSystem.FileSystem,
        config = yield* ServerConfig.ServerConfig;
      yield* fs.makeDirectory(`${config.stateDir}/workflows.json`);
      const result = yield* service
        .mutate({ type: "save", workflow: workflowFixture() })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect((yield* snapshot(service)).workflows).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "uses the server switch and applies setting changes without polling client storage",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem,
          config = yield* ServerConfig.ServerConfig;
        yield* fs.writeFileString(`${config.stateDir}/client-settings.json`, "not JSON");
        const change = yield* Deferred.make<void>(),
          delivered = yield* Deferred.make<void>();
        const h = harness(
          [],
          Stream.never,
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, workflowsBeta: false }),
            subscribeChanges: Effect.succeed(
              Stream.fromEffect(Deferred.await(change)).pipe(
                Stream.map(() => ({ ...DEFAULT_SERVER_SETTINGS, workflowsBeta: true })),
                Stream.ensuring(Deferred.succeed(delivered, undefined)),
              ),
            ),
          }),
        );
        const service = yield* h.openScoped;
        expect(workflowsBetaEnabled()).toBe(false);
        yield* service.mutate({ type: "save", workflow: workflowFixture() });
        expect(
          (yield* service
            .start({ workflowId: workflowFixture().id, task: "Build" })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(h.launches).toHaveLength(0);
        yield* Deferred.succeed(change, undefined);
        yield* Deferred.await(delivered);
        expect(workflowsBetaEnabled()).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("doesn't call a lead's per-chat scratch folder a worktree", () =>
    Effect.gen(function* () {
      const h = harness(),
        service = yield* h.open,
        workflow = workflowFixture();
      yield* service.mutate({ type: "save", workflow });
      const { leadThreadId } = yield* service.start({ workflowId: workflow.id, task: "Build" });
      const base = idleThreadProjection(liveThreadShell(leadThreadId));
      h.projections.set(leadThreadId, {
        ...base,
        thread: { ...base.thread, worktreePath: "/test/scratch/2026-11-07-build" },
      });
      yield* service.refresh;
      const run = (yield* snapshot(service)).runs[0]!;
      expect(run.diagnostics?.map((d) => d.kind) ?? []).not.toContain("placement");
      expect(run.agents.find((a) => a.threadId === leadThreadId)?.isolation).toBe("shared");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("exposes observed model and workspace differences in run state", () =>
    Effect.gen(function* () {
      const h = harness(),
        service = yield* h.open,
        workflow = workflowFixture();
      yield* service.mutate({ type: "save", workflow });
      const { leadThreadId } = yield* service.start({ workflowId: workflow.id, task: "Build" });
      const base = idleThreadProjection(liveThreadShell(leadThreadId));
      h.projections.set(leadThreadId, {
        ...base,
        thread: {
          ...base.thread,
          modelSelection: { ...selection, model: "different-model" },
          worktreePath: "/test/isolated",
        },
      });
      yield* service.refresh;
      expect((yield* snapshot(service)).runs[0]!.diagnostics?.map((d) => d.kind)).toEqual(
        expect.arrayContaining(["model", "placement"]),
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("refreshes only the indexed run affected by a thread event", () =>
    Effect.gen(function* () {
      const event =
        yield* Deferred.make<
          Stream.Success<Threads.ThreadManagementService["Service"]["streamDomainEvents"]>
        >();
      const h = harness([], Stream.fromEffect(Deferred.await(event))),
        service = yield* h.openScoped;
      const workflow = workflowFixture();
      yield* service.mutate({ type: "save", workflow });
      const first = yield* service.start({ workflowId: workflow.id, task: "First" });
      const second = yield* service.start({ workflowId: workflow.id, task: "Second" });
      const time = DateTime.makeUnsafe("2026-11-06T12:00:00.000Z");
      const run: OrchestrationV2ThreadProjection["runs"][number] = {
        id: RunId.make("event-run"),
        threadId: first.leadThreadId,
        ordinal: 1,
        providerInstanceId: selection.instanceId,
        modelSelection: selection,
        providerThreadId: null,
        userMessageId: MessageId.make("event-message"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "completed",
        requestedAt: time,
        startedAt: time,
        completedAt: time,
        checkpointId: null,
        contextHandoffId: null,
      };
      const base = idleThreadProjection(liveThreadShell(first.leadThreadId));
      h.projections.set(first.leadThreadId, { ...base, runs: [run] });
      h.recordReads.length = 0;
      const changed = yield* service.subscribe().pipe(
        Stream.filter((s) => s.runs.find((r) => r.id === first.runId)?.status === "completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* Deferred.succeed(event, {
        id: EventId.make("workflow-event"),
        type: "run.updated",
        threadId: first.leadThreadId,
        occurredAt: time,
        payload: run,
      });
      yield* Fiber.join(changed);
      expect(h.recordReads).toEqual([first.leadThreadId]);
      expect(h.recordReads).not.toContain(second.leadThreadId);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "keeps policy ownership when terminal history is full and while a cancelled run still has live agents",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem,
          config = yield* ServerConfig.ServerConfig;
        const active = {
          ...runFixture(),
          id: WorkflowRunId.make("old-active"),
          status: "cancelled" as const,
        };
        const history = Array.from({ length: 205 }, (_, i) => ({
          ...runFixture(),
          id: WorkflowRunId.make(`history-${i}`),
          status: "completed" as const,
          agents: [],
        }));
        yield* fs.writeFileString(
          `${config.stateDir}/workflows.json`,
          JSON.stringify({ version: 1, workflows: [], runs: [...history, active] }),
        );
        const h = harness(),
          service = yield* h.open;
        expect((yield* snapshot(service)).runs).toHaveLength(201);
        yield* service.mutate({ type: "deleteRun", runId: active.id });
        expect((yield* snapshot(service)).runs.some((r) => r.id === active.id)).toBe(true);
        const stored = JSON.parse(yield* fs.readFileString(`${config.stateDir}/workflows.json`));
        expect(stored.activeRuns.map((run: { id: string }) => run.id)).toEqual([active.id]);
        expect(stored.runs).toHaveLength(200);
        expect(stored.runs.some((run: { id: string }) => run.id === active.id)).toBe(false);
        let executed = false;
        const denied = yield* service
          .delegate(active.leadThreadId, "closed", { task: "Off plan" }, selection, () =>
            Effect.sync(() => {
              executed = true;
              return delegationResult(ThreadId.make("never"));
            }),
          )
          .pipe(Effect.result);
        expect(denied._tag).toBe("Failure");
        expect(executed).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("preserves unreadable storage and retries after the I/O error is repaired", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem,
        config = yield* ServerConfig.ServerConfig;
      const path = `${config.stateDir}/workflows.json`;
      // Reading a directory fails as I/O, independently of the test user's permissions.
      yield* fs.makeDirectory(path);
      const h = harness();
      const service = yield* h.open;
      const result = yield* snapshot(service).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure).toMatchObject({ reason: "read" });
      expect(yield* fs.exists(`${path}.unreadable`)).toBe(false);
      expect(yield* fs.exists(path)).toBe(true);
      yield* fs.remove(path, { recursive: true });
      yield* fs.writeFileString(
        path,
        JSON.stringify({ version: 1, workflows: [workflowFixture()], runs: [] }),
      );
      expect((yield* snapshot(service)).workflows).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("recovers corrupt storage and bounds newest runs at 200", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem,
        config = yield* ServerConfig.ServerConfig;
      const path = `${config.stateDir}/workflows.json`;
      yield* fs.writeFileString(path, "bad");
      const h = harness();
      expect((yield* snapshot(yield* h.open)).runs).toEqual([]);
      expect(yield* fs.readFileString(`${path}.unreadable`)).toBe("bad");
      const run = runFixture(),
        data: WorkflowsState = {
          version: 1,
          workflows: [],
          runs: Array.from({ length: 205 }, (_, i) => ({
            ...run,
            id: WorkflowRunId.make(`run-${i}`),
            status: "completed",
            agents: run.agents.map((a) => ({ ...a, status: "completed" })),
          })),
        };
      yield* fs.writeFileString(path, JSON.stringify(data));
      const service = yield* h.open,
        state = yield* snapshot(service);
      expect(state.runs).toHaveLength(200);
      expect(state.runs[199]!.id).toBe("run-199");
      yield* service.mutate({ type: "save", workflow: workflowFixture() });
      expect(JSON.parse(yield* fs.readFileString(path)).runs).toHaveLength(200);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect(
    "stops only one branch, including its descendants, and leaves sibling admission open",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const service = yield* h.open,
          source = workflowFixture();
        const workflow = {
          ...source,
          nodes: source.nodes.map((n) =>
            n.id === "worker" && n.kind === "agent"
              ? { ...n, count: { kind: "upTo" as const, max: 2 } }
              : n,
          ),
        };
        yield* service.mutate({ type: "save", workflow });
        const { runId, leadThreadId } = yield* service.start({
          workflowId: workflow.id,
          task: "Build",
        });
        const worker = ThreadId.make("stop-worker"),
          sibling = ThreadId.make("keep-worker"),
          nested = ThreadId.make("stop-nested");
        for (const [key, child] of [
          ["worker-a", worker],
          ["worker-b", sibling],
        ] as const)
          yield* service.delegate(leadThreadId, key, { task: "Work" }, selection, () =>
            Effect.succeed(delegationResult(child)),
          );
        yield* service.delegate(worker, "nested", { task: "Help" }, selection, () =>
          Effect.succeed(delegationResult(nested)),
        );
        const parent = idleThreadProjection(liveThreadShell(worker));
        h.projections.set(worker, { ...parent, subagents: [taskProjection(worker, nested)] });
        yield* service.mutate({ type: "stopAgent", runId, threadId: worker });
        expect(h.interrupted).toEqual([worker, nested]);
        const run = (yield* snapshot(service)).runs[0]!;
        expect(run.status).not.toBe("cancelled");
        expect(run.agents.filter((a) => a.status === "cancelled").map((a) => a.threadId)).toEqual([
          worker,
          nested,
        ]);
        expect(run.agents.find((a) => a.threadId === sibling)?.status).toBe("running");
        expect(
          (yield* service
            .delegate(worker, "late", { task: "Help" }, selection, () =>
              Effect.succeed(delegationResult(ThreadId.make("forbidden"))),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(h.dispatched.filter((c) => c.type === "message.dispatch")).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "retries the original brief and placement in one slot, keeps history, and sends one parent notice",
    () =>
      Effect.gen(function* () {
        const h = harness(),
          service = yield* h.open,
          workflow = workflowFixture();
        yield* service.mutate({ type: "save", workflow });
        const { runId, leadThreadId } = yield* service.start({
          workflowId: workflow.id,
          task: "Build",
        });
        const base = idleThreadProjection(liveThreadShell(leadThreadId));
        h.projections.set(leadThreadId, {
          ...base,
          runs: [runProjection(leadThreadId, "running")],
        });
        const child = ThreadId.make("original-child");
        let originalBrief = "";
        yield* service.delegate(
          leadThreadId,
          "original",
          { task: "Keep this brief", target: { model: selection.model }, isolation: "shared" },
          selection,
          (input) =>
            Effect.sync(() => {
              originalBrief = input.task;
              return delegationResult(child, "completed");
            }),
        );
        const task = taskProjection(leadThreadId, child, "completed");
        h.projections.set(leadThreadId, {
          ...base,
          runs: [runProjection(leadThreadId, "completed")],
          subagents: [task],
        });
        yield* service.refresh;
        yield* service.mutate({ type: "retryAgent", runId, threadId: child });
        yield* service.mutate({ type: "retryAgent", runId, threadId: child });
        const run = (yield* snapshot(service)).runs[0]!,
          retried = run.agents[2]!;
        expect(retried).toMatchObject({
          nodeId: "worker",
          slot: 0,
          retryOf: child,
          parentThreadId: leadThreadId,
          isolation: "shared",
          status: "running",
        });
        expect(run.agents[1]).toMatchObject({ threadId: child, status: "completed" });
        expect(h.dispatched.filter((c) => c.type === "delegated_task.request")).toEqual([
          expect.objectContaining({
            task: originalBrief,
            parentThreadId: leadThreadId,
            completionWake: "always",
            modelSelection: selection,
            context: { version: 1, records: [expect.objectContaining({ nodeId: "worker" })] },
          }),
        ]);
        expect(h.dispatched.filter((c) => c.type === "message.dispatch")).toHaveLength(1);
        expect(
          (yield* service
            .mutate({ type: "retryAgent", runId, threadId: retried.threadId })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* service.mutate({ type: "stopAgent", runId, threadId: retried.threadId });
        yield* service.mutate({ type: "retryAgent", runId, threadId: retried.threadId });
        expect((yield* snapshot(service)).runs[0]!.agents[3]).toMatchObject({
          retryOf: retried.threadId,
          slot: 0,
        });
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "persists explicit membership before launch and replays an accepted launch after a lost response",
    () =>
      Effect.gen(function* () {
        const h = harness(),
          service = yield* h.open,
          source = workflowFixture();
        const model = { ...selection, options: [{ id: "reasoningEffort", value: "low" }] };
        const workflow = {
          ...source,
          nodes: source.nodes.map((n) =>
            n.kind === "agent" && n.id === "worker" ? { ...n, model } : n,
          ),
        };
        yield* service.mutate({ type: "save", workflow });
        const { runId, leadThreadId } = yield* service.start({
          workflowId: workflow.id,
          task: "Build",
        });
        const parentRun = runProjection(leadThreadId, "running");
        const key = "durable-child",
          child = derive.delegatedTaskThread({ commandId: CommandId.make(key) });
        let context: WorkflowContextRecord | undefined;
        yield* service
          .delegate(
            leadThreadId,
            key,
            { task: "Original task", title: "Renamed task" },
            selection,
            (input, record, admit) =>
              Effect.gen(function* () {
                context = record;
                const fs = yield* FileSystem.FileSystem,
                  config = yield* ServerConfig.ServerConfig;
                const stored = JSON.parse(
                  yield* fs.readFileString(`${config.stateDir}/workflows.json`),
                );
                expect(stored.activeRuns[0].agents[1]).toMatchObject({
                  threadId: child,
                  nodeId: "worker",
                  slot: 0,
                });
                expect(stored.admissions.find((a: { key: string }) => a.key === key).launched).toBe(
                  false,
                );
                expect(record?.nodeId).toBe("worker");
                expect(input.target?.options).toEqual(model.options);
                yield* admit!({
                  type: "delegated_task.request",
                  commandId: CommandId.make(key),
                  parentThreadId: leadThreadId,
                  parentRunId: parentRun.id,
                  parentNodeId: parentRun.rootNodeId!,
                  task: input.task,
                  modelSelection: model,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  createdBy: "agent",
                  creationSource: "mcp",
                });
                return yield* Effect.fail("lost response");
              }),
          )
          .pipe(Effect.result);
        const restored = yield* h.openScoped;
        yield* restored.subscribe().pipe(
          Stream.filter((s) => s.runs.find((r) => r.id === runId)?.agents[1]?.status === "running"),
          Stream.runHead,
        );
        expect(h.dispatched.filter((c) => c.type === "delegated_task.request")).toEqual([
          expect.objectContaining({ modelSelection: model }),
        ]);
        expect((yield* snapshot(restored)).runs[0]!.agents[1]).toMatchObject({
          nodeId: "worker",
          slot: 0,
          threadId: child,
        });
        expect(context?.nodeId).toBe("worker");
        const wrong = ThreadId.make("unmapped-same-model-title");
        h.projections.set(leadThreadId, {
          ...idleThreadProjection(liveThreadShell(leadThreadId)),
          subagents: [taskProjection(leadThreadId, wrong)],
        });
        yield* restored.refresh;
        expect((yield* snapshot(restored)).runs[0]!.agents.some((a) => a.threadId === wrong)).toBe(
          false,
        );
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live(
    "refreshes needs on request events and lead grades on ranking events without publishing notes",
    () =>
      Effect.gen(function* () {
        const events =
          yield* PubSub.unbounded<
            Stream.Success<Threads.ThreadManagementService["Service"]["streamDomainEvents"]>
          >();
        const rankings = yield* Layer.build(Rankings.layer).pipe(
          Effect.map((c) => Context.get(c, Rankings.SubagentRankings)),
        );
        const h = harness(
          [],
          Stream.fromPubSub(events),
          ServerSettings.layerTest({ workflowsBeta: true }),
          [Layer.succeed(Rankings.SubagentRankings, rankings)],
        );
        const service = yield* h.openScoped,
          workflow = workflowFixture();
        yield* service.mutate({ type: "save", workflow });
        const { leadThreadId } = yield* service.start({ workflowId: workflow.id, task: "Work" });
        const request = {
          id: RuntimeRequestId.make("approval"),
          nodeId: NodeId.make("request-node"),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "command" as const,
          status: "pending" as const,
          responseCapability: {
            type: "live" as const,
            providerSessionId: ProviderSessionId.make("test"),
          },
          createdAt: testTime,
          resolvedAt: null,
        };
        const base = idleThreadProjection(liveThreadShell(leadThreadId));
        const observe = (predicate: (s: WorkflowsState) => boolean) =>
          service.subscribe().pipe(Stream.filter(predicate), Stream.runHead, Effect.forkChild);
        const pending = yield* observe((s) => s.runs[0]?.agents[0]?.needs === "approval");
        h.projections.set(leadThreadId, { ...base, runtimeRequests: [request] });
        yield* PubSub.publish(events, {
          id: EventId.make("requested"),
          type: "runtime-request.updated",
          threadId: leadThreadId,
          occurredAt: testTime,
          payload: request,
        });
        yield* Fiber.join(pending);
        const answered = { ...request, status: "resolved" as const, resolvedAt: testTime };
        const cleared = yield* observe((s) => s.runs[0]?.agents[0]?.needs === undefined);
        h.projections.set(leadThreadId, { ...base, runtimeRequests: [answered] });
        yield* PubSub.publish(events, {
          id: EventId.make("answered"),
          type: "runtime-request.updated",
          threadId: leadThreadId,
          occurredAt: testTime,
          payload: answered,
        });
        yield* Fiber.join(cleared);
        const child = ThreadId.make("graded-child");
        yield* service.delegate(leadThreadId, "graded", { task: "Work" }, selection, () =>
          Effect.succeed(delegationResult(child, "completed")),
        );
        const task = taskProjection(leadThreadId, child, "completed");
        h.projections.set(leadThreadId, { ...base, subagents: [task] });
        yield* service.refresh;
        yield* rankings.record([
          {
            taskId: task.id,
            instanceId: selection.instanceId,
            model: selection.model,
            family: "gpt",
            kind: "code",
            outcome: "completed",
            elapsedMs: 1,
            fixRounds: 0,
            finishedAt: DateTime.toEpochMillis(yield* DateTime.now),
          },
        ]);
        const graded = yield* observe((s) => s.runs[0]?.agents[1]?.grade === 4);
        yield* rankings.grade(task.id, { score: 4, note: "Private review note" });
        const result = Option.getOrThrow(yield* Fiber.join(graded));
        expect(JSON.stringify(result)).not.toContain("Private review note");
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    10_000,
  );
  it.effect("retries with the admitted worktree commit, repository, options and brief", () =>
    Effect.gen(function* () {
      const h = harness(),
        service = yield* h.open,
        source = workflowFixture();
      const model = { ...selection, options: [{ id: "effort", value: "high" }] };
      const workflow = {
        ...source,
        nodes: source.nodes.map((n) =>
          n.id === "worker" && n.kind === "agent"
            ? { ...n, isolation: "worktree" as const, model }
            : n,
        ),
      };
      yield* service.mutate({ type: "save", workflow });
      const { leadThreadId, runId } = yield* service.start({
        workflowId: workflow.id,
        task: "Build",
      });
      const parentRun = runProjection(leadThreadId, "completed"),
        child = ThreadId.make("isolated-original");
      const workspaceStrategy = {
        type: "worktree" as const,
        baseRef: "original-commit",
        sourcePath: "/private/tmp/original-repo",
        startFromOrigin: false,
      };
      yield* service.delegate(
        leadThreadId,
        "isolated",
        {
          task: "Original work",
          isolation: "worktree",
          repositoryPath: workspaceStrategy.sourcePath,
        },
        selection,
        (input, _context, admit) =>
          Effect.gen(function* () {
            yield* admit!({
              type: "delegated_task.request",
              commandId: CommandId.make("isolated"),
              parentThreadId: leadThreadId,
              parentRunId: parentRun.id,
              parentNodeId: parentRun.rootNodeId!,
              task: input.task,
              modelSelection: model,
              runtimeMode: "full-access",
              interactionMode: "default",
              workspaceStrategy,
              createdBy: "agent",
              creationSource: "mcp",
            });
            return delegationResult(child, "completed");
          }),
      );
      yield* service.mutate({ type: "retryAgent", runId, threadId: child });
      expect(h.dispatched.find((c) => c.type === "delegated_task.request")).toMatchObject({
        workspaceStrategy,
        modelSelection: model,
        task: expect.stringContaining("Original work"),
      });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("retries a dedicated lead in its root slot and preserves the old chat", () =>
    Effect.gen(function* () {
      const h = harness(),
        service = yield* h.open,
        source = workflowFixture();
      const model = { ...selection, options: [{ id: "reasoningEffort", value: "xhigh" }] };
      const workflow = {
        ...source,
        nodes: source.nodes.map((n) =>
          n.kind === "agent" && n.id === "lead" ? { ...n, model } : n,
        ),
      };
      yield* service.mutate({ type: "save", workflow });
      const { leadThreadId, runId } = yield* service.start({
        workflowId: workflow.id,
        task: "Root brief",
      });
      h.projections.set(leadThreadId, {
        ...idleThreadProjection(liveThreadShell(leadThreadId)),
        runs: [runProjection(leadThreadId, "failed")],
      });
      yield* service.refresh;
      yield* service.mutate({ type: "retryAgent", runId, threadId: leadThreadId });
      const run = (yield* snapshot(service)).runs[0]!;
      expect(run.leadThreadId).not.toBe(leadThreadId);
      expect(run.agents).toEqual([
        expect.objectContaining({ threadId: leadThreadId, status: "failed" }),
        expect.objectContaining({
          nodeId: "lead",
          slot: 0,
          retryOf: leadThreadId,
          parentThreadId: null,
        }),
      ]);
      expect(h.launches.map((l) => l.modelSelection)).toEqual([model, model]);
      expect(h.launches[1]!.initialMessage?.text).toBe(h.launches[0]!.initialMessage?.text);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("restores a workflow lead admitted as an external parent's task before launch", () =>
    Effect.gen(function* () {
      const h = harness(),
        service = yield* h.open,
        source = workflowFixture();
      const model = { ...selection, options: [{ id: "reasoningEffort", value: "xhigh" }] };
      const workflow = {
        ...source,
        nodes: source.nodes.map((n) =>
          n.kind === "agent" && n.id === "lead" ? { ...n, model } : n,
        ),
      };
      yield* service.mutate({ type: "save", workflow });
      const parent = ThreadId.make("outer-parent"),
        key = "external-lead",
        lead = derive.delegatedTaskThread({ commandId: CommandId.make(key) });
      h.projections.set(parent, {
        ...idleThreadProjection(liveThreadShell(parent)),
        runs: [runProjection(parent, "completed")],
      });
      yield* service
        .startChild(
          {
            workflowId: workflow.id,
            task: "Lead brief",
            key,
            leadThreadId: lead,
            parentThreadId: parent,
          },
          () => Effect.fail("crash before spawn"),
        )
        .pipe(Effect.result);
      const restored = yield* h.openScoped;
      yield* restored.subscribe().pipe(
        Stream.filter((s) => s.runs[0]?.agents[0]?.status === "running"),
        Stream.runHead,
      );
      expect(h.dispatched.find((c) => c.type === "delegated_task.request")).toMatchObject({
        parentThreadId: parent,
        modelSelection: model,
        context: { records: [expect.objectContaining({ nodeId: "lead" })] },
      });
      expect((yield* snapshot(restored)).runs[0]!.leadThreadId).toBe(lead);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect("keeps a failed stop live and refuses to retry it until interruption succeeds", () =>
    Effect.gen(function* () {
      const h = harness(),
        service = yield* h.open,
        workflow = workflowFixture();
      yield* service.mutate({ type: "save", workflow });
      const { leadThreadId, runId } = yield* service.start({
        workflowId: workflow.id,
        task: "Build",
      });
      const child = ThreadId.make("blocked-stop");
      yield* service.delegate(leadThreadId, "blocked-stop", { task: "Work" }, selection, () =>
        Effect.succeed(delegationResult(child)),
      );
      h.interruptFailures.add(child);
      expect(
        (yield* service.mutate({ type: "stopAgent", runId, threadId: child }).pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
      yield* service.refresh;
      expect((yield* snapshot(service)).runs[0]!.agents[1]!.status).toBe("running");
      expect(
        (yield* service.mutate({ type: "retryAgent", runId, threadId: child }).pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
      h.interruptFailures.delete(child);
      yield* service.mutate({ type: "stopAgent", runId, threadId: child });
      expect((yield* snapshot(service)).runs[0]!.agents[1]!.status).toBe("cancelled");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect("passes only the newest predecessor result after a retry", () =>
    Effect.gen(function* () {
      const h = harness(),
        service = yield* h.open,
        source = workflowFixture();
      const workflow = {
        ...source,
        edges: [
          ...source.edges.map((e) =>
            e.to === "helper" ? { ...e, from: WorkflowNodeId.make("lead") } : e,
          ),
          {
            id: WorkflowEdgeId.make("sequence"),
            kind: "then" as const,
            from: WorkflowNodeId.make("worker"),
            to: WorkflowNodeId.make("helper"),
          },
        ],
      };
      yield* service.mutate({ type: "save", workflow });
      const { leadThreadId, runId } = yield* service.start({
        workflowId: workflow.id,
        task: "Build",
      });
      const parent = idleThreadProjection(liveThreadShell(leadThreadId));
      h.projections.set(leadThreadId, {
        ...parent,
        runs: [runProjection(leadThreadId, "running")],
      });
      const original = ThreadId.make("old-predecessor");
      yield* service.delegate(
        leadThreadId,
        "predecessor",
        { task: "Work", title: "worker" },
        selection,
        () => Effect.succeed(delegationResult(original, "completed")),
      );
      yield* service.mutate({ type: "retryAgent", runId, threadId: original });
      const retry = (yield* snapshot(service)).runs[0]!.agents.find((a) => a.retryOf === original)!;
      h.projections.set(leadThreadId, {
        ...parent,
        runs: [runProjection(leadThreadId, "running")],
        subagents: [
          { ...taskProjection(leadThreadId, original, "completed"), result: "obsolete-output" },
          {
            ...taskProjection(leadThreadId, retry.threadId, "completed"),
            result: "current-output",
          },
        ],
      });
      h.projections.set(retry.threadId, {
        ...idleThreadProjection(liveThreadShell(retry.threadId)),
        runs: [runProjection(retry.threadId, "completed")],
      });
      yield* service.refresh;
      yield* service.delegate(
        leadThreadId,
        "successor",
        { task: "Review", title: "helper" },
        selection,
        (input) =>
          Effect.sync(() => {
            expect(input.task).toContain("current-output");
            expect(input.task).not.toContain("obsolete-output");
            return delegationResult(ThreadId.make("successor"));
          }),
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

describe("retainWorkflowRuns", () => {
  it("never trims a run still going, however much finished history follows it", () => {
    const finished = Array.from({ length: 250 }, (_, i) => ({
      id: `done-${i}`,
      status: "completed",
    }));
    const runs = [
      ...finished.slice(0, 220),
      { id: "active", status: "running" },
      ...finished.slice(220),
    ];
    const kept = Workflows.retainWorkflowRuns(runs);
    expect(kept.some((run) => run.id === "active")).toBe(true);
    expect(kept.filter((run) => run.status === "completed")).toHaveLength(200);
    expect(kept[0]?.id).toBe("done-0");
  });
});
