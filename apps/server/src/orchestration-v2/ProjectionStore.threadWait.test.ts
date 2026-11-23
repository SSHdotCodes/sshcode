import { expect, it } from "@effect/vitest";
import { EventId, MessageId, ProviderDriverKind, RunId, TurnItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { liveThreadShell, idleThreadProjection } from "../mcp/McpToolAccess.testkit.ts";
import { ThreadId } from "@t3tools/contracts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

it.effect(
  "SQL and hydrated shells agree while a thread wait starts, overlaps execution, and ends",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:thread-wait");
      const thread = idleThreadProjection(liveThreadShell(threadId)).thread;
      const runId = RunId.make("run:thread-wait");
      const at = thread.createdAt;
      const driver = ProviderDriverKind.make("codex");
      yield* store.apply({
        id: EventId.make("wait-thread"),
        type: "thread.created",
        threadId,
        occurredAt: at,
        payload: thread,
      });
      const run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: thread.providerInstanceId!,
        modelSelection: thread.modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:wait"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "running" as const,
        requestedAt: at,
        startedAt: at,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      yield* store.apply({
        id: EventId.make("wait-run"),
        type: "run.created",
        threadId,
        runId,
        occurredAt: at,
        payload: run,
      });
      const baseItem = {
        threadId,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        title: null,
        startedAt: at,
        completedAt: null,
        updatedAt: at,
      };
      const wait = {
        ...baseItem,
        id: TurnItemId.make("item:wait"),
        ordinal: 1,
        type: "dynamic_tool" as const,
        status: "running" as const,
        toolName: "mcp__t3-code__t3_thread_wait",
        input: {},
        output: null,
      };
      const publishWait = (status: "running" | "completed") =>
        store.apply({
          id: EventId.make(`wait-item-${status}`),
          type: "turn-item.updated",
          threadId,
          runId,
          driver,
          providerInstanceId: thread.providerInstanceId!,
          occurredAt: at,
          payload: { ...wait, status },
        });
      const assertState = (waiting: boolean) =>
        Effect.gen(function* () {
          const sql = yield* store.getThreadShell(threadId);
          const listed = (yield* store.getShellSnapshot()).threads.find(
            (item) => item.id === threadId,
          );
          const hydrated = ProjectionStore.threadShellFromProjection(
            yield* store.getThreadProjection(threadId),
          );
          for (const shell of [sql, listed, hydrated]) {
            expect(shell?.blockedOnThreadWait).toBe(waiting ? true : undefined);
          }
        });
      yield* assertState(false);
      yield* publishWait("running");
      yield* assertState(true);
      const edit = {
        ...baseItem,
        id: TurnItemId.make("item:edit"),
        ordinal: 2,
        type: "file_change" as const,
        fileName: "page.html",
        diffStr: "",
        oldStr: "",
        newStr: "",
      };
      for (const status of ["running", "completed"] as const) {
        yield* store.apply({
          id: EventId.make(`edit-${status}`),
          type: "turn-item.updated",
          threadId,
          runId,
          driver,
          providerInstanceId: thread.providerInstanceId!,
          occurredAt: at,
          payload: { ...edit, status },
        });
        // An edit beside the wait does not count: the list query cannot see it, and
        // the stored and rebuilt shells must agree.
        yield* assertState(true);
      }
      yield* publishWait("completed");
      yield* assertState(false);
    }).pipe(Effect.provide(ProjectionStore.layer.pipe(Layer.provide(Sqlite.layerMemory)))),
);
