import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ScheduledTask,
  ScheduledTaskUpsertInput,
  ScheduledTaskListResult,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertSchedule,
} from "./scheduledTask.ts";

const decodeSchedule = Schema.decodeUnknownSync(ScheduledTaskSchedule);
const decodeUpsertSchedule = Schema.decodeUnknownSync(ScheduledTaskUpsertSchedule);

describe("ScheduledTaskSchedule", () => {
  it("keeps legacy sub-minute persisted schedules readable", () => {
    expect(
      decodeSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
    });
  });

  it("still rejects corrupt non-positive persisted intervals", () => {
    expect(() => decodeSchedule({ type: "interval", everyMs: 0 })).toThrow();
  });
});

describe("ScheduledTaskUpsertSchedule", () => {
  it("accepts interval schedules at the one-minute minimum", () => {
    expect(
      decodeUpsertSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS,
    });
  });

  it("rejects interval schedules more frequent than once per minute", () => {
    expect(() =>
      decodeUpsertSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toThrow();
  });
});

describe("one-shot schedules", () => {
  it("round trips a UTC instant and its draft workspace intent", () => {
    const schedule = { type: "once", runAt: "2027-01-15T14:30:00.000Z", prepareWorkspace: true };
    expect(decodeSchedule(schedule)).toEqual(schedule);
    expect(decodeUpsertSchedule(schedule)).toEqual(schedule);
  });
  it.each([
    "2027-01-15T14:30",
    "2027-01-15T14:30:00+05:00",
    "2027-02-30T14:30:00.000Z",
    "not a date",
  ])("rejects an ambiguous or invalid date %s", (runAt) => {
    expect(() => decodeUpsertSchedule({ type: "once", runAt })).toThrow();
  });
});

const decodeTask = Schema.decodeUnknownSync(ScheduledTask);
const decodeUpsert = Schema.decodeUnknownSync(ScheduledTaskUpsertInput);
const decodeList = Schema.decodeUnknownSync(ScheduledTaskListResult);

it.each([undefined, false, true])(
  "round trips task account pin %s on writes and client reads",
  (accountPinned) => {
    const input = {
      title: "Check",
      prompt: "Check progress",
      enabled: false,
      schedule: { type: "interval", everyMs: 60_000 },
      projectId: "project:test",
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: "codex", model: "model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      ...(accountPinned === undefined ? {} : { accountPinned }),
    };
    expect(decodeUpsert(input).accountPinned).toBe(accountPinned);
    const task = {
      ...input,
      id: "task:test",
      createdBy: "user",
      creationSource: "web",
      createdAt: "2026-11-17T12:00:00Z",
      updatedAt: "2026-11-17T12:00:00Z",
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunError: null,
      runCount: 0,
    };
    expect(decodeTask(task).accountPinned).toBe(accountPinned);
    expect(decodeList({ tasks: [task] }).tasks[0]?.accountPinned).toBe(accountPinned);
  },
);
