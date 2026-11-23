import * as ScheduledTaskState from "./ScheduledTaskState.ts";
import * as ScheduledTaskStateTest from "./ScheduledTaskState.testkit.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput, type ScheduledTaskId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ScheduledTasks from "./ScheduledTaskService.ts";

const decodeInput = Schema.decodeUnknownSync(ScheduledTaskUpsertInput);
const input = decodeInput({
  commandId: "scheduled-message-test",
  title: "Follow up",
  prompt: "Review the result.",
  enabled: true,
  schedule: { type: "once", runAt: "2027-01-15T14:30:00.000Z" },
  projectId: "project:test",
  threadId: "thread:test",
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
});

const makeHarness = (
  options: {
    readonly raceAtClaim?: boolean;
    readonly targetAlreadyUsed?: boolean;
    readonly nonGit?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const poll = yield* Ref.make(Effect.void);
    const sends: Array<
      Parameters<ThreadManagement.ThreadManagementService["Service"]["sendToThread"]>[0]
    > = [];
    const launches: Array<ThreadLaunch.ThreadLaunchInput> = [];
    let targetReads = 0;
    const acceptedReceipts = new Set<string>();
    const rejectedReceipts = new Set<string>();
    const acceptedMessages = new Set<string>();
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.succeed(Scheduler.Scheduler, {
        register: <E, R>(_name: string, work: Effect.Effect<void, E, R>) =>
          Effect.gen(function* () {
            const context = yield* Effect.context<R>();
            yield* Ref.set(poll, work.pipe(Effect.provideContext(context), Effect.ignoreCause));
          }),
      }),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        sendToThread: (send) =>
          Effect.sync(() => {
            sends.push(send);
            acceptedReceipts.add(send.commandId);
            acceptedMessages.add(send.messageId);
          }).pipe(Effect.as({} as never)),
        hasReceipt: (commandId, settings) =>
          Effect.succeed(
            acceptedReceipts.has(commandId) ||
              (settings?.acceptedOnly !== true && rejectedReceipts.has(commandId)),
          ),
        getProjectThreadRecords: () =>
          Effect.sync(
            () =>
              ({
                runs:
                  options.targetAlreadyUsed || (options.raceAtClaim && targetReads++ > 0)
                    ? [{}]
                    : [],
              }) as never,
          ),
        getMessageCount: () => Effect.succeed(0),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        isNonGitProject: () => Effect.succeed(options.nonGit === true),
        launch: (launch) =>
          Effect.sync(() => {
            launches.push(launch);
            if (options.raceAtClaim) rejectedReceipts.add(launch.commandId);
            else {
              acceptedReceipts.add(launch.commandId);
              acceptedReceipts.add(`${launch.commandId}:initial-message`);
              if (launch.initialMessage?.messageId)
                acceptedMessages.add(launch.initialMessage.messageId);
            }
          }).pipe(
            Effect.andThen(
              options.raceAtClaim
                ? Effect.fail(
                    new ThreadLaunch.ThreadLaunchError({
                      operation: "update-thread",
                      commandId: launch.commandId,
                      projectId: launch.projectId,
                      cause: "Thread is no longer empty",
                    }),
                  )
                : Effect.succeed({} as never),
            ),
          ),
      }),
    );
    const layer = ScheduledTasks.layer.pipe(Layer.provide(dependencies));
    const tick = Ref.get(poll).pipe(Effect.flatten);
    return { layer, tick, sends, launches, acceptedMessages };
  });

it.effect(
  "delivers overdue one-shot messages once without a client and keeps recurring jobs queued",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2027-01-15T12:00:00.000Z"));
      const h = yield* makeHarness();
      yield* Effect.gen(function* () {
        const tasks = yield* ScheduledTasks.ScheduledTaskService;
        const { task } = yield* tasks.upsert(input);
        yield* h.tick;
        expect(h.sends).toHaveLength(0);
        // One-shot messages catch up even days late; daily automation's grace window does not apply.
        yield* TestClock.setTime(Date.parse("2027-01-17T12:00:00.000Z"));
        yield* h.tick;
        expect(h.sends).toHaveLength(1);
        expect(h.sends[0]).toMatchObject({
          threadId: "thread:test",
          text: input.prompt,
          mode: "auto",
          scheduledTaskId: task.id,
        });
        // The chat it is bound to keeps its own model, whatever the schedule stored.
        expect(h.sends[0]).not.toHaveProperty("modelSelection");
        const delivered = (yield* tasks.list()).tasks[0]!;
        expect(delivered).toMatchObject({
          lastRunStatus: "succeeded",
          runCount: 1,
          nextRunAt: null,
        });
        yield* h.tick;
        yield* tasks.setEnabled({ id: task.id, enabled: false });
        yield* tasks.setEnabled({ id: task.id, enabled: true });
        yield* h.tick;
        expect(h.sends).toHaveLength(1);

        const recurring = yield* tasks.upsert({
          ...input,
          commandId: undefined,
          schedule: { type: "interval", everyMs: 60_000 },
        });
        yield* tasks.runNow({ id: recurring.task.id });
        expect(h.sends[1]?.mode).toBe("queue");
        expect(h.sends[1]).not.toHaveProperty("modelSelection");
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.provide(Layer.mergeAll(Sqlite.layerMemory, ScheduledTaskStateTest.layer))),
);

it.effect("a replayed create preserves a later edit and pause", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2027-01-15T12:00:00.000Z"));
    const h = yield* makeHarness();
    yield* Effect.gen(function* () {
      const tasks = yield* ScheduledTasks.ScheduledTaskService;
      const { task } = yield* tasks.upsert(input);
      yield* tasks.upsert({ ...input, id: task.id, prompt: "Changed", enabled: false });
      const replay = yield* tasks.upsert(input);
      expect(replay.task).toMatchObject({
        id: task.id,
        prompt: "Changed",
        enabled: false,
        nextRunAt: null,
      });
      yield* TestClock.setTime(Date.parse("2027-01-15T15:00:00.000Z"));
      yield* h.tick;
      expect(h.sends).toHaveLength(0);
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.provide(Layer.mergeAll(Sqlite.layerMemory, ScheduledTaskStateTest.layer))),
);

it.effect.each(["edit", "toggle"] as const)(
  "resumes a paused one-shot occurrence after an earlier occurrence ran (%s)",
  (reenable) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2027-01-15T12:00:00.000Z"));
      const h = yield* makeHarness();
      yield* Effect.gen(function* () {
        const tasks = yield* ScheduledTasks.ScheduledTaskService;
        const { task } = yield* tasks.upsert(input);
        yield* tasks.runNow({ id: task.id });
        const schedule = { type: "once", runAt: "2027-01-16T14:30:00.000Z" } as const;
        yield* tasks.upsert({ ...input, id: task.id, schedule, enabled: false });
        yield* TestClock.setTime(Date.parse(schedule.runAt) + 5_000);
        yield* h.tick;
        expect(h.sends).toHaveLength(1);
        const resumed =
          reenable === "edit"
            ? yield* tasks.upsert({ ...input, id: task.id, schedule, enabled: true })
            : yield* tasks.setEnabled({ id: task.id, enabled: true });
        expect(resumed.task.nextRunAt).toBe(schedule.runAt);
        yield* h.tick;
        yield* h.tick;
        expect(h.sends).toHaveLength(2);
        expect(h.acceptedMessages.size).toBe(2);
        expect((yield* tasks.list()).tasks[0]).toMatchObject({ runCount: 2, nextRunAt: null });
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.provide(Layer.mergeAll(Sqlite.layerMemory, ScheduledTaskStateTest.layer))),
);

it.effect("resumes a one-shot that replaced a recurring schedule after history expired", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2027-01-15T12:00:00.000Z"));
    const h = yield* makeHarness();
    yield* Effect.gen(function* () {
      const tasks = yield* ScheduledTasks.ScheduledTaskService;
      const { task } = yield* tasks.upsert({
        ...input,
        schedule: { type: "interval", everyMs: 60_000 },
      });
      yield* tasks.runNow({ id: task.id });
      yield* tasks.upsert({ ...input, id: task.id, enabled: false });
      yield* (yield* ScheduledTaskState.ScheduledTaskState).update((state) => ({
        ...state,
        runs: [],
      }));
      const resumed = yield* tasks.setEnabled({ id: task.id, enabled: true });
      expect(resumed.task.nextRunAt).toBe("2027-01-15T14:30:00.000Z");
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.provide(Layer.mergeAll(Sqlite.layerMemory, ScheduledTaskStateTest.layer))),
);

it.effect("replays the same durable dispatch identity after a restart interrupted completion", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2027-01-15T12:00:00.000Z"));
    const h = yield* makeHarness();
    let id: ScheduledTaskId | undefined;
    yield* Effect.gen(function* () {
      const tasks = yield* ScheduledTasks.ScheduledTaskService;
      const created = yield* tasks.upsert(input);
      id = created.task.id;
      yield* TestClock.setTime(Date.parse("2027-01-15T14:30:05.000Z"));
      yield* h.tick;
    }).pipe(Effect.provide(h.layer));
    const sql = yield* SqlClient.SqlClient;
    // Crash window: orchestrator accepted the message but the task completion did not commit.
    yield* sql`UPDATE scheduled_tasks SET last_run_status = 'running', run_count = 0, next_run_at = ${input.schedule.type === "once" ? input.schedule.runAt : ""} WHERE task_id = ${id}`;
    yield* TestClock.setTime(Date.parse("2027-01-16T20:00:00.000Z"));
    yield* Effect.gen(function* () {
      const tasks = yield* ScheduledTasks.ScheduledTaskService;
      yield* h.tick;
      expect(h.sends).toHaveLength(2);
      expect(h.sends[1]?.commandId).toBe(h.sends[0]?.commandId);
      expect(h.sends[1]?.messageId).toBe(h.sends[0]?.messageId);
      expect((yield* tasks.list()).tasks[0]).toMatchObject({
        nextRunAt: null,
        lastRunStatus: "succeeded",
        runCount: 1,
      });
      yield* h.tick;
      expect(h.sends).toHaveLength(2);
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.provide(Layer.mergeAll(Sqlite.layerMemory, ScheduledTaskStateTest.layer))),
);

it.effect("prepares a persisted draft target through the normal launch path on delivery", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2027-01-15T12:00:00.000Z"));
    const h = yield* makeHarness();
    yield* Effect.gen(function* () {
      const tasks = yield* ScheduledTasks.ScheduledTaskService;
      yield* tasks.upsert({
        ...input,
        schedule: { type: "once", runAt: "2027-01-15T14:30:00.000Z", prepareWorkspace: true },
        workspaceStrategy: { type: "worktree", baseRef: "main" },
      });
      yield* TestClock.setTime(Date.parse("2027-01-15T14:30:05.000Z"));
      yield* h.tick;
      expect(h.sends).toHaveLength(0);
      expect(h.launches).toHaveLength(1);
      expect(h.launches[0]).toMatchObject({
        threadId: "thread:test",
        reuseExistingThread: true,
        workspaceStrategy: { type: "worktree", baseRef: "main" },
        initialMessage: { text: input.prompt, attachments: [] },
      });
      const task = (yield* tasks.list()).tasks[0]!;
      expect((yield* tasks.runNow({ id: task.id })).task.lastRunStatus).toBe("succeeded");
      expect(h.sends).toHaveLength(0);
      expect(h.launches).toHaveLength(2);
      expect(h.acceptedMessages.size).toBe(1);
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.provide(Layer.mergeAll(Sqlite.layerMemory, ScheduledTaskStateTest.layer))),
);

it.effect("runs a task saved with a worktree in a non-Git project at its folder", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2027-01-15T12:00:00.000Z"));
    const h = yield* makeHarness({ nonGit: true });
    yield* Effect.gen(function* () {
      const tasks = yield* ScheduledTasks.ScheduledTaskService;
      const saved = yield* tasks.upsert({
        ...input,
        schedule: { type: "once", runAt: "2027-01-15T14:30:00.000Z", prepareWorkspace: true },
        workspaceStrategy: { type: "worktree", baseRef: "main" },
      });
      expect(saved.task.workspaceStrategy).toEqual({ type: "root" });
      // A task stored with a worktree before this rule still runs in the folder.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE scheduled_tasks SET workspace_strategy_json = ${JSON.stringify({ type: "worktree", baseRef: "main" })}`;
      yield* TestClock.setTime(Date.parse("2027-01-15T14:30:05.000Z"));
      yield* h.tick;
      expect(h.launches).toHaveLength(1);
      expect(h.launches[0]?.workspaceStrategy).toEqual({ type: "root" });
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.provide(Layer.mergeAll(Sqlite.layerMemory, ScheduledTaskStateTest.layer))),
);

it.effect(
  "rejects past delivery times, honors edits and cancellations, and keeps failed prompts visible",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2027-01-15T12:00:00.000Z"));
      const h = yield* makeHarness();
      yield* Effect.gen(function* () {
        const tasks = yield* ScheduledTasks.ScheduledTaskService;
        const past = yield* tasks
          .upsert({ ...input, schedule: { type: "once", runAt: "2027-01-14T12:00:00.000Z" } })
          .pipe(Effect.flip);
        expect(past.message).toBe("Choose a future date and time for the message.");
        const { task } = yield* tasks.upsert(input);
        yield* tasks.upsert({
          ...input,
          id: task.id,
          requireExisting: true,
          prompt: "Updated prompt",
          schedule: { type: "once", runAt: "2027-01-16T14:30:00.000Z" },
        });
        yield* TestClock.setTime(Date.parse("2027-01-15T15:00:00.000Z"));
        yield* h.tick;
        expect(h.sends).toHaveLength(0);
        yield* tasks.delete({ id: task.id });
        yield* TestClock.setTime(Date.parse("2027-01-17T15:00:00.000Z"));
        yield* h.tick;
        expect(h.sends).toHaveLength(0);
      }).pipe(Effect.provide(h.layer));
      // A failed dispatch is terminal and reviewable; it does not silently drop the saved prompt.
      yield* Effect.gen(function* () {
        const tasks = yield* ScheduledTasks.ScheduledTaskService;
        const created = yield* tasks.upsert({
          ...input,
          schedule: { type: "once", runAt: "2027-01-18T12:00:00.000Z" },
        });
        yield* TestClock.setTime(Date.parse("2027-01-18T12:00:05.000Z"));
        yield* tasks.runNow({ id: created.task.id });
        expect((yield* tasks.list()).tasks[0]).toMatchObject({
          id: created.task.id,
          prompt: input.prompt,
          lastRunStatus: "failed",
          nextRunAt: null,
        });
      }).pipe(
        Effect.provide(
          ScheduledTasks.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                NodeCrypto.layer,
                Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
                Layer.mock(SecretRequests.SecretRequests)({}),
                Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
                Layer.mock(ThreadManagement.ThreadManagementService)({
                  sendToThread: () => Effect.die("fixture dispatch failure"),
                }),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(Layer.mergeAll(Sqlite.layerMemory, ScheduledTaskStateTest.layer))),
);

it.effect("delivers to a draft another send claimed between the empty check and launch", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2027-01-15T12:00:00.000Z"));
    const h = yield* makeHarness({ raceAtClaim: true });
    yield* Effect.gen(function* () {
      const tasks = yield* ScheduledTasks.ScheduledTaskService;
      const { task } = yield* tasks.upsert({
        ...input,
        schedule: { type: "once", runAt: "2027-01-15T14:30:00.000Z", prepareWorkspace: true },
      });
      const result = yield* tasks.runNow({ id: task.id });
      expect(result.task.lastRunStatus).toBe("succeeded");
      expect(h.launches).toHaveLength(1);
      expect(h.sends).toHaveLength(1);
      expect(h.sends[0]).toMatchObject({
        threadId: input.threadId,
        text: input.prompt,
        mode: "auto",
        commandId: `${h.launches[0]?.commandId}:initial-message`,
      });
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.provide(Layer.mergeAll(Sqlite.layerMemory, ScheduledTaskStateTest.layer))),
);

it.effect.each(["already used", "claim race"] as const)(
  "replays a prepared draft's normal delivery after Run now and restart: %s",
  (scenario) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2027-01-15T12:00:00.000Z"));
      const h = yield* makeHarness(
        scenario === "already used" ? { targetAlreadyUsed: true } : { raceAtClaim: true },
      );
      const taskId = yield* Effect.gen(function* () {
        const tasks = yield* ScheduledTasks.ScheduledTaskService;
        const { task } = yield* tasks.upsert({
          ...input,
          schedule: { type: "once", runAt: "2027-01-15T14:30:00.000Z", prepareWorkspace: true },
        });
        expect((yield* tasks.runNow({ id: task.id })).task.lastRunStatus).toBe("succeeded");
        const replay = yield* tasks.runNow({ id: task.id });
        expect(replay.task.lastRunStatus).toBe("succeeded");
        expect(h.acceptedMessages.size).toBe(1);
        expect(replay.task.runCount).toBe(1);
        expect((yield* tasks.list()).tasks[0]?.runCount).toBe(1);
        expect(h.launches).toHaveLength(scenario === "already used" ? 0 : 1);
        return task.id;
      }).pipe(Effect.provide(h.layer));
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE scheduled_tasks SET last_run_status = 'running', run_count = 0, next_run_at = '2027-01-15T14:30:00.000Z' WHERE task_id = ${taskId}`;
      yield* TestClock.setTime(Date.parse("2027-01-16T12:00:00.000Z"));
      yield* Effect.gen(function* () {
        const tasks = yield* ScheduledTasks.ScheduledTaskService;
        yield* h.tick;
        expect((yield* tasks.list()).tasks[0]).toMatchObject({
          nextRunAt: null,
          lastRunStatus: "succeeded",
          runCount: 1,
        });
        expect(h.acceptedMessages.size).toBe(1);
        expect(new Set(h.sends.map((send) => send.commandId)).size).toBe(1);
        expect(h.launches).toHaveLength(scenario === "already used" ? 0 : 1);
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.provide(Layer.mergeAll(Sqlite.layerMemory, ScheduledTaskStateTest.layer))),
);

it.effect("counts each one-time occurrence once even when the schedule is edited back", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2027-01-15T12:00:00.000Z"));
    const h = yield* makeHarness();
    yield* Effect.gen(function* () {
      const tasks = yield* ScheduledTasks.ScheduledTaskService;
      const { task } = yield* tasks.upsert(input);
      expect((yield* tasks.runNow({ id: task.id })).task.runCount).toBe(1);
      yield* tasks.upsert({
        ...input,
        id: task.id,
        schedule: { type: "once", runAt: "2027-01-16T14:30:00.000Z" },
      });
      expect((yield* tasks.runNow({ id: task.id })).task.runCount).toBe(2);
      yield* tasks.upsert({ ...input, id: task.id });
      expect((yield* tasks.runNow({ id: task.id })).task.runCount).toBe(2);
      expect(h.acceptedMessages.size).toBe(2);
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.provide(Layer.mergeAll(Sqlite.layerMemory, ScheduledTaskStateTest.layer))),
);

it.effect("records the scheduled time and skipped outcome for a missed fixed-time occurrence", () =>
  Effect.gen(function* () {
    const due = DateTime.makeZonedUnsafe(
      { year: 2027, month: 1, day: 15, hour: 12, minute: 0, second: 0, millisecond: 0 },
      {
        timeZone: DateTime.zoneMakeLocal(),
        adjustForTimeZone: true,
      },
    );
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.subtract(due, { minutes: 1 })));
    const h = yield* makeHarness();
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTasks.ScheduledTaskService;
      const { task } = yield* service.upsert({
        ...input,
        threadId: undefined,
        schedule: { type: "fixed_time", timeOfDay: "12:00" },
      });
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.add(due, { minutes: 20 })));
      yield* h.tick;
      const history = yield* service.listRuns({ id: task.id });
      expect(history.runs[0]).toMatchObject({
        scheduledAt: DateTime.formatIso(DateTime.toUtc(due)),
        dispatchStatus: "skipped",
        runStatus: null,
      });
      expect(h.launches).toHaveLength(0);
      expect(h.sends).toHaveLength(0);
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.provide(Layer.mergeAll(Sqlite.layerMemory, ScheduledTaskStateTest.layer))),
);
