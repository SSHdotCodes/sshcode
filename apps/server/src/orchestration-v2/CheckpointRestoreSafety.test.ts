import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import { isCheckpointRestoreIsolated } from "./CheckpointRestoreSafety.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

it.effect.each([
  "nested",
  "ancestor",
  "archived-nested",
  ...(symlinksSupported ? (["aliased-nested"] as const) : []),
  "project",
  "provider",
  "scope",
  "sibling",
  "stopped-provider",
  "errored-provider",
  "shared-provider",
  "conversation",
] as const)("preserves overlapping workspace files, owner=%s", (owner) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-restore-" });
    const cwd = path.join(parent, "worktree");
    const nested = path.join(cwd, "nested");
    const sibling = path.join(parent, "worktree2");
    yield* fs.makeDirectory(nested, { recursive: true });
    yield* fs.makeDirectory(sibling);
    const otherFile = path.join(nested, "other-thread.txt");
    yield* fs.writeFileString(otherFile, "other thread's uncommitted work");
    const alias = path.join(parent, "alias");
    if (owner === "aliased-nested") yield* fs.symlink(nested, alias);
    const threadId = ThreadId.make("restore-current");
    const otherId = ThreadId.make("restore-other");
    const projectId = ProjectId.make("restore-project");
    const providerThreadId = ProviderThreadId.make("restore-provider");
    const providerSessionId = ProviderSessionId.make("restore-session");
    const instanceId = ProviderInstanceId.make("restore-instance");
    const checkpointId = CheckpointId.make("restore-checkpoint");
    const scopeId = CheckpointScopeId.make("restore-scope");
    const calls: string[] = [];
    const providerThread = {
      id: providerThreadId,
      providerSessionId,
      providerInstanceId: instanceId,
    };
    const otherThread = {
      id: otherId,
      projectId,
      deletedAt: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: otherId },
      worktreePath:
        owner === "project"
          ? null
          : owner === "ancestor" || owner === "conversation"
            ? parent
            : owner === "nested" || owner === "archived-nested"
              ? nested
              : owner === "aliased-nested"
                ? alias
                : sibling,
    };
    const projection = {
      thread: {
        id: threadId,
        projectId,
        worktreePath: cwd,
        activeProviderThreadId: providerThreadId,
        modelSelection: { instanceId, model: "test" },
      },
      providerThreads: [providerThread],
      providerSessions: [],
      providerTurns: [],
      nodes: [],
      attempts: [],
      checkpoints: [{ id: checkpointId, scopeId, status: "ready", appRunOrdinal: null }],
      checkpointScopes: [{ id: scopeId, cwd }],
      runs: [{ id: "later-run", ordinal: 1, status: "completed", rootNodeId: null }],
    } as unknown as OrchestrationV2ThreadProjection;
    const layerTest = CheckpointRollbackService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          ThreadCommandExecutor.layer,
          IdAllocator.layer,
          Layer.mock(GitWorkflowService.GitWorkflowService)({}),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: () => Effect.succeed(Option.some({ workspaceRoot: parent } as never)),
          }),
          Layer.mock(ProjectionStoreV2)({
            getThreadRecords: () => Effect.succeed(projection),
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads: owner === "archived-nested" ? [] : ([otherThread] as never),
                archivedThreads: owner === "archived-nested" ? ([otherThread] as never) : [],
              }),
            getCheckpointContext: () =>
              Effect.succeed({
                runs: [],
                checkpoints: [],
                checkpointScopes: owner === "scope" ? ([{ cwd: nested }] as never) : [],
              }),
            getThreadProviderContext: () =>
              Effect.succeed({
                thread: otherThread as never,
                providerThreads: [],
                providerSessions: [
                  "provider",
                  "stopped-provider",
                  "errored-provider",
                  "shared-provider",
                ].includes(owner)
                  ? ([
                      {
                        // One session shared by every thread keeps the cwd of
                        // the thread that opened it, here this thread's.
                        cwd: owner === "shared-provider" ? cwd : nested,
                        status:
                          owner === "provider" || owner === "shared-provider"
                            ? "running"
                            : owner === "errored-provider"
                              ? "error"
                              : "stopped",
                        capabilities: {
                          sessions: {
                            supportsMultipleProviderThreadsPerSession: owner === "shared-provider",
                          },
                        },
                      },
                    ] as never)
                  : [],
              }),
          }),
          Layer.mock(CheckpointServiceV2)({
            restore: () =>
              Effect.gen(function* () {
                calls.push("files");
                yield* fs.remove(otherFile).pipe(Effect.orDie);
              }),
          }),
          Layer.mock(EventSinkV2)({ write: () => Effect.succeed([]) }),
          Layer.mock(ProviderSessionManagerV2)({
            open: () =>
              Effect.succeed({
                rollbackThread: () =>
                  Effect.sync(() => {
                    calls.push("provider");
                    return { providerThread };
                  }),
              } as never),
          }),
          Layer.mock(RuntimePolicyV2)({ resolve: () => Effect.succeed({} as never) }),
        ),
      ),
    );
    const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2.pipe(
      Effect.provide(layerTest),
    );
    const restoreFiles = owner !== "conversation";
    const rejected = !["sibling", "stopped-provider", "shared-provider", "conversation"].includes(
      owner,
    );
    if (rejected) {
      const error = yield* service
        .execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles })
        .pipe(Effect.flip);
      assert.equal(error.reason, "shared-workspace");
      assert.deepEqual(calls, []);
      assert.equal(yield* fs.readFileString(otherFile), "other thread's uncommitted work");
    } else {
      yield* service.execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles });
      assert.deepEqual(calls, restoreFiles ? ["provider", "files"] : ["provider"]);
      assert.equal(yield* fs.exists(otherFile), !restoreFiles);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("lets rollback recreate a worktree storage cleanup removed", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-v2-restore-removed-" });
    const worktreePath = path.join(parent, "worktree");
    const isolated = yield* isCheckpointRestoreIsolated(
      { id: ThreadId.make("restore-removed"), worktreePath },
      { cwd: worktreePath },
      {
        fileSystem,
        path,
        projections: {
          getShellSnapshot: () => Effect.succeed({ threads: [], archivedThreads: [] }),
        } as never,
        projects: {} as never,
      },
    );
    assert.isTrue(isolated);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { name: "completed child", isolated: true },
  { name: "completed native child", isolated: true },
  { name: "native child with running tool", isolated: false },
  { name: "native child with provider background task", isolated: false },
  { name: "native child with parent background task", isolated: false },
  { name: "native child with another provider parent task", isolated: true },
  { name: "native child grandchild with root background task", isolated: false },
  { name: "missing task record", isolated: false },
  { name: "task belongs to another child", isolated: false },
  { name: "completed child with pending task", isolated: false },
  { name: "grandchild through fork", isolated: false },
  { name: "completed grandchild", isolated: true },
  { name: "unrelated child", isolated: false },
  { name: "running child", isolated: false },
  { name: "held queue", isolated: false },
  { name: "failed child", isolated: false },
  { name: "cyclic ancestry", isolated: false },
] as const)("parent file restore with $name: $isolated", ({ name, isolated }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const worktreePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-restore-child-" });
    const parentId = ThreadId.make("restore-parent");
    const childId = ThreadId.make("restore-child");
    const ancestorId = ThreadId.make("restore-ancestor");
    const nested =
      name === "completed grandchild" ||
      name === "native child grandchild with root background task" ||
      name === "grandchild through fork" ||
      name === "cyclic ancestry";
    const native = name.includes("native child");
    const child = {
      id: childId,
      projectId: ProjectId.make("restore-project"),
      deletedAt: null,
      worktreePath,
      activeRunId: name === "running child" ? "child-run" : null,
      activityRunStatus: null,
      latestRunId: native ? null : "child-run",
      creationSource: native ? "provider" : "user",
      forkedFrom: { type: "node", nodeId: "child-task" },
      status: native
        ? "idle"
        : name === "running child"
          ? "running"
          : name === "failed child"
            ? "failed"
            : "completed",
      pendingRuntimeRequest: null,
      pendingBackgroundTasks: [],
      lineage: {
        parentThreadId: nested
          ? ancestorId
          : name === "unrelated child"
            ? ThreadId.make("another-parent")
            : parentId,
        relationshipToParent: "subagent",
        rootThreadId: parentId,
      },
    };
    const ancestor = {
      ...child,
      id: ancestorId,
      forkedFrom: { type: "node", nodeId: "ancestor-task" },
      lineage: {
        ...child.lineage,
        relationshipToParent: name === "grandchild through fork" ? "fork" : "subagent",
        parentThreadId: name === "cyclic ancestry" ? childId : parentId,
      },
    };
    const task = (id: string, childThreadId: string) => ({
      id,
      providerInstanceId: "claude",
      nativeTaskRef: { nativeId: "native-task" },
      childThreadId,
      origin: native ? "provider_native" : "app_owned",
      status: name === "completed child with pending task" ? "running" : "completed",
    });
    const projections = {
      getShellSnapshot: () =>
        Effect.succeed({ threads: nested ? [child, ancestor] : [child], archivedThreads: [] }),
      getCheckpointContext: () =>
        Effect.succeed({
          checkpointScopes: [],
          runs: name === "held queue" ? [{ status: "queued" }] : [],
        }),
      getThreadProviderContext: () => Effect.succeed({ providerSessions: [] }),
      getThreadRecords: (
        threadId: unknown,
        _fields: readonly string[],
        filter: { turnItemStatuses?: string[] } = {},
      ) =>
        Effect.succeed({
          providerThreads:
            threadId === parentId &&
            native &&
            (name.includes("parent") ||
              name === "native child grandchild with root background task")
              ? [
                  {
                    providerInstanceId:
                      name === "native child with another provider parent task"
                        ? "other-provider"
                        : "claude",
                    status: "idle",
                    pendingBackgroundTasks: [{ taskId: "background", kind: "command" }],
                  },
                ]
              : name === "native child with provider background task"
                ? [{ status: "idle", pendingBackgroundTasks: [{ taskId: "background" }] }]
                : [],
          turnItems:
            filter.turnItemStatuses !== undefined && name === "native child with running tool"
              ? [{ type: "command_execution", status: "running" }]
              : [],
          subagents:
            name === "missing task record"
              ? []
              : [
                  task(
                    "child-task",
                    name === "task belongs to another child" ? "another-child" : childId,
                  ),
                  task("ancestor-task", ancestorId),
                ],
        }),
    };
    const result = yield* isCheckpointRestoreIsolated(
      { id: parentId, worktreePath },
      { cwd: worktreePath },
      { fileSystem, path, projections: projections as never, projects: {} as never },
    );
    assert.equal(result, isolated);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
