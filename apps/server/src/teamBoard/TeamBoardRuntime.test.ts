import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as TeamBoard from "./TeamBoard.ts";
import { BOARD_CROSS_CHAT_PREFIX } from "./TeamBoardMailbox.ts";
import * as TeamBoardRuntime from "./TeamBoardRuntime.ts";

it.effect(
  "admits prepared siblings and does not deliver cross-chat overlap notices to a solo chat",
  () =>
    Effect.gen(function* () {
      const board = yield* TeamBoard.TeamBoard;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const lead = ThreadId.make("lead");
      const outsideChat = ThreadId.make("outside");
      const timestamp = yield* DateTime.now;
      const projectId = ProjectId.make("fixture");
      const instanceId = ProviderInstanceId.make("codex");
      const modelSelection = { instanceId, model: "fixture" };
      let repositoryReads = 0;
      const crossChatNotices = new Map<ThreadId, string>();
      const delivered = yield* Deferred.make<void>();
      const baselineRead = yield* Deferred.make<void>();
      const firstStatus = yield* Deferred.make<void>();
      const trailingStatus = yield* Deferred.make<void>();
      let firstStatusReads = 0;
      let outsideEdited = false;
      const base = "a".repeat(40);
      const diff = (file: string, line: number) =>
        `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -${line} +${line} @@\n-a\n+b\n`;
      const dirty = (file: string) => `1 .M N... 100644 100644 100644 ${base} ${base} ${file}\0`;
      yield* Layer.build(
        TeamBoardRuntime.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(TeamBoard.TeamBoard, board),
              Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
              Layer.mock(ProjectStore.ProjectStoreV2)({
                get: () =>
                  Effect.succeed(
                    Option.some({
                      projectId,
                      title: "Fixture project",
                      workspaceRoot: "/lab/root",
                      defaultModelSelection: null,
                      defaultThreadEnvMode: null,
                      autoPull: false,
                      faviconPath: null,
                      projectIcon: null,
                      scripts: [],
                      createdAt: DateTime.formatIso(timestamp),
                      updatedAt: DateTime.formatIso(timestamp),
                      deletedAt: null,
                    }),
                  ),
              }),
              Layer.mock(EventSink.EventSinkV2)({
                latestSequence: () => Effect.succeed(0),
                stream: () => Stream.empty,
              }),
              Layer.mock(ThreadManagement.ThreadManagementService)({
                sendToThread: ({ text, threadId }) =>
                  Effect.gen(function* () {
                    if (text.startsWith(BOARD_CROSS_CHAT_PREFIX + "Another chat")) {
                      crossChatNotices.set(threadId, text);
                      if (crossChatNotices.size === 1)
                        yield* Deferred.succeed(delivered, undefined);
                    }
                    return yield* new ThreadManagement.ThreadManagementNoSteerableRunError({
                      threadId,
                      mode: "steer",
                    });
                  }),
              }),
              Layer.mock(Git.GitVcsDriver)({
                execute: ({ args, cwd }) =>
                  Effect.gen(function* () {
                    repositoryReads += 1;
                    let stdout = `${base}\n`;
                    if (args.includes("--git-common-dir")) stdout = "/lab/.git\n";
                    else if (args.includes("status")) {
                      stdout = `# branch.oid ${base}\0`;
                      if (cwd === "/lab/first" || cwd === "/lab/second" || outsideEdited)
                        stdout += dirty("settings.ts");
                      if (cwd === "/lab/root") {
                        stdout += dirty("already-dirty.ts");
                        yield* Deferred.succeed(baselineRead, undefined);
                      }
                      if (cwd === "/lab/first") {
                        firstStatusReads++;
                        if (firstStatusReads === 1) yield* Deferred.succeed(firstStatus, undefined);
                        if (firstStatusReads === 2)
                          yield* Deferred.succeed(trailingStatus, undefined);
                      }
                    } else if (args.includes("diff")) {
                      stdout = args.includes("settings.ts")
                        ? diff("settings.ts", cwd === "/lab/second" ? 50 : 40)
                        : "";
                      if (args.includes("already-dirty.ts")) stdout += diff("already-dirty.ts", 40);
                    }
                    return {
                      stdout,
                      stderr: "",
                      exitCode: ChildProcessSpawner.ExitCode(0),
                      stdoutTruncated: false,
                      stderrTruncated: false,
                    };
                  }),
              }),
            ),
          ),
        ),
      );
      const create = (threadId: ThreadId, child: boolean) =>
        projections.apply({
          id: EventId.make(`created-${threadId}`),
          type: "thread.created",
          threadId,
          occurredAt: timestamp,
          payload: {
            id: threadId,
            projectId,
            title: threadId === outsideChat ? "Parallel chat" : "Fixture",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: child ? `fixture-${threadId}` : null,
            worktreePath: child ? `/lab/${threadId}` : null,
            activeProviderThreadId: null,
            lineage: {
              parentThreadId: child ? lead : null,
              relationshipToParent: child ? "subagent" : null,
              rootThreadId: lead,
            },
            forkedFrom: child ? { type: "node", nodeId: NodeId.make(`task-${threadId}`) } : null,
            createdBy: "user",
            creationSource: "web",
            createdAt: timestamp,
            updatedAt: timestamp,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
      yield* create(lead, false);
      const children = [ThreadId.make("first"), ThreadId.make("second")];
      const run = (threadId: ThreadId, status: "starting" | "running") => ({
        id: RunId.make(`run-${threadId}`),
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make(`input-${threadId}`),
        rootNodeId: null,
        activeAttemptId: null,
        status,
        requestedAt: timestamp,
        startedAt: timestamp,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      });
      for (const threadId of children) {
        yield* create(threadId, true);
        const taskId = NodeId.make(`task-${threadId}`);
        yield* projections.apply({
          id: EventId.make(`assigned-${threadId}`),
          type: "subagent.updated",
          threadId: lead,
          occurredAt: timestamp,
          payload: {
            id: taskId,
            threadId: lead,
            childThreadId: threadId,
            runId: null,
            parentNodeId: NodeId.make("parent-node"),
            origin: "app_owned",
            createdBy: "user",
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: instanceId,
            providerThreadId: null,
            nativeTaskRef: null,
            prompt: "Fixture task",
            title: threadId,
            model: "fixture",
            status: "running",
            result: null,
            startedAt: timestamp,
            completedAt: null,
            updatedAt: timestamp,
          },
        });
      }
      for (const threadId of children) {
        const runId = RunId.make(`run-${threadId}`);
        yield* projections.apply({
          id: EventId.make(`prepared-${threadId}`),
          type: "run.created",
          threadId,
          runId,
          occurredAt: timestamp,
          payload: run(threadId, "starting"),
        });
        yield* board.prepareChild(lead, threadId);
        if (threadId === children[0]) {
          expect(repositoryReads).toBe(0);
          expect(board.available(lead)).toBe(false);
        }
      }
      expect(repositoryReads).toBe(4);
      expect(board.available(lead)).toBe(true);
      expect(children.every(board.available)).toBe(true);
      yield* create(outsideChat, false);
      for (const threadId of [...children, outsideChat]) {
        const payload = run(threadId, "running");
        yield* projections.apply({
          id: EventId.make(`live-${threadId}`),
          type: threadId === outsideChat ? "run.created" : "run.updated",
          threadId,
          runId: payload.id,
          occurredAt: timestamp,
          payload,
        });
      }
      yield* board.access(lead, { post: { kind: "finding", text: "Private team finding" } });
      yield* board.access(children[0]!, {
        post: {
          kind: "claim",
          text: "Inspect the rule parser",
          files: ["rules.ts"],
        },
      });
      yield* TestClock.adjust("5 seconds");
      expect(firstStatusReads).toBe(0);
      yield* board.refreshAfterTool(children[0]!);
      yield* Deferred.await(firstStatus);
      for (let i = 0; i < 8; ++i) yield* board.refreshAfterTool(children[0]!);
      yield* TestClock.adjust("9 seconds");
      expect(firstStatusReads).toBe(1);
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(trailingStatus);
      expect(firstStatusReads).toBe(2);
      yield* TestClock.adjust("45 seconds");
      yield* Deferred.await(baselineRead);
      expect(crossChatNotices.size).toBe(0);
      outsideEdited = true;
      yield* TestClock.adjust("60 seconds");
      yield* Deferred.await(delivered);
      expect(crossChatNotices.get(children[0]!)).toBe(
        BOARD_CROSS_CHAT_PREFIX + "Another chat in this repo is also changing settings.ts.",
      );
      expect(crossChatNotices.has(outsideChat)).toBe(false);
      expect(board.reserveNotices(outsideChat)).toBeUndefined();
      expect(board.available(outsideChat)).toBe(false);
      expect((yield* board.access(outsideChat, {}).pipe(Effect.exit))._tag).toBe("Failure");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(ProjectionStore.layerMemory, TeamBoard.layer).pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "team-board-runtime-" })),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);
