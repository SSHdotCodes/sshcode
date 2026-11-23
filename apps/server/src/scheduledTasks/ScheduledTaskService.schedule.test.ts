import * as ScheduledTaskStateTest from "./ScheduledTaskState.testkit.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  MessageId,
  RunId,
  ScheduledTaskId,
  ScheduledTaskUpsertInput,
  type OrchestrationV2Run,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

it.effect("rejects a stale form save after deletion while preserving explicit-id creates", () =>
  Effect.gen(function* () {
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* decodeUpsertInput({
        id: "scheduled-task:edit-after-delete",
        title: "Review",
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project-stale-schedule",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const created = yield* service.upsert(input);
      const edit = yield* decodeUpsertInput({ ...input, requireExisting: true, title: "Edited" });
      expect((yield* service.upsert(edit)).task.title).toBe("Edited");
      yield* service.delete({ id: created.task.id });

      const failure = yield* service.upsert(edit).pipe(Effect.flip);
      expect(failure.message).toBe("Schedule task not found.");
      expect((yield* service.list()).tasks).toEqual([]);

      expect((yield* service.upsert(input)).task.id).toBe(created.task.id);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(
    Effect.provide(Layer.mergeAll(SqlitePersistence.layerMemory, ScheduledTaskStateTest.layer)),
  ),
);

it.effect("preserves a due run when a save only pads the scheduled hour", () =>
  Effect.gen(function* () {
    const dueAt = DateTime.makeZonedUnsafe(
      { year: 2026, month: 7, day: 1, hour: 9, minute: 0, second: 0, millisecond: 0 },
      { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
    );
    yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) - 1_000);

    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* decodeUpsertInput({
        commandId: "schedule-time-format",
        title: "Morning review",
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "fixed_time", timeOfDay: "9:00" },
        projectId: "project-schedule-time-format",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        creationSource: "mcp",
      });
      const created = yield* service.upsert(input);
      const expectedDueAt = DateTime.formatIso(DateTime.toUtc(dueAt));
      expect(created.task.nextRunAt).toBe(expectedDueAt);

      // Cross the due time before the scheduler's first five-second tick.
      yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) + 1_000);
      const update = yield* decodeUpsertInput({
        ...input,
        id: created.task.id,
        schedule: { type: "fixed_time", timeOfDay: "09:00" },
      });
      const updated = yield* service.upsert(update);
      expect(updated.task.nextRunAt).toBe(expectedDueAt);
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBe(expectedDueAt);

      const rescheduled = yield* service.upsert({
        ...update,
        schedule: { type: "fixed_time", timeOfDay: "09:30" },
      });
      expect(rescheduled.task.nextRunAt).toBe(
        DateTime.formatIso(DateTime.toUtc(DateTime.add(dueAt, { minutes: 30 }))),
      );
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(
    Effect.provide(Layer.mergeAll(SqlitePersistence.layerMemory, ScheduledTaskStateTest.layer)),
  ),
);

it.effect("keeps one queued recurring occurrence, while manual and one-time runs still send", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
    const poll = yield* Ref.make(Effect.void);
    const runs: OrchestrationV2Run[] = [];
    const messages: OrchestrationV2ConversationMessage[] = [];
    const queue = (
      messageId: MessageId,
      taskId: OrchestrationV2ConversationMessage["scheduledTaskId"],
    ) => {
      const run = {
        id: RunId.make(`run:${messageId}`),
        userMessageId: messageId,
        status: "queued",
        completedAt: null,
      } as OrchestrationV2Run;
      runs.push(run);
      messages.push({
        id: messageId,
        scheduledTaskId: taskId,
      } as OrchestrationV2ConversationMessage);
    };
    // A different task in the same chat must not block this one.
    queue(MessageId.make("other-message"), ScheduledTaskId.make("task:other"));
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.mock(Scheduler.Scheduler)({
        register: (_name, work) =>
          Effect.context<Effect.Services<typeof work>>().pipe(
            Effect.flatMap((context) =>
              Ref.set(poll, work.pipe(Effect.provideContext(context), Effect.ignore)),
            ),
          ),
      }),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        sendToThread: (input) =>
          Effect.sync(() => {
            queue(input.messageId, input.scheduledTaskId);
            return {} as never;
          }),
        getThreadRecords: (_threadId, _fields, filter) =>
          Effect.succeed({
            runs,
            messages:
              filter?.messageIds === undefined
                ? messages
                : messages.filter((m) => filter.messageIds!.includes(m.id)),
          } as never),
      }),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* decodeUpsertInput({
        id: "task:coalesce",
        title: "Check progress",
        prompt: "Check progress",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project:test",
        threadId: "thread:busy",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const { task } = yield* service.upsert(input);
      const tick = Ref.get(poll).pipe(Effect.flatten);
      const count = (id: typeof task.id) =>
        runs.filter(
          (r) =>
            r.status === "queued" &&
            messages.find((m) => m.id === r.userMessageId)?.scheduledTaskId === id,
        ).length;
      for (let n = 0; n < 3; n++) {
        yield* TestClock.adjust("61 seconds");
        yield* tick;
      }
      expect(count(task.id)).toBe(1);
      const listed = (yield* service.list()).tasks[0]!;
      expect(Date.parse(listed.nextRunAt!)).toBeGreaterThan(Date.parse("2026-07-01T09:03:03.000Z"));
      expect(
        (yield* service.listRuns({ id: task.id })).runs.filter(
          (r) => r.dispatchStatus === "skipped",
        ),
      ).toHaveLength(2);
      yield* service.runNow({ id: task.id });
      expect(count(task.id)).toBe(2);
      for (let i = 0; i < runs.length; i++) runs[i] = { ...runs[i]!, status: "running" };
      yield* TestClock.adjust("61 seconds");
      yield* tick;
      expect(count(task.id)).toBe(1);
      const { task: once } = yield* service.upsert({
        ...input,
        id: ScheduledTaskId.make("task:once"),
        schedule: { type: "once", runAt: "2026-07-01T09:05:00.000Z" },
      });
      queue(MessageId.make("once-already-queued"), once.id);
      yield* TestClock.adjust("61 seconds");
      yield* tick;
      expect(count(once.id)).toBe(2);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(dependencies))));
  }).pipe(
    Effect.provide(Layer.mergeAll(SqlitePersistence.layerMemory, ScheduledTaskStateTest.layer)),
  ),
);
