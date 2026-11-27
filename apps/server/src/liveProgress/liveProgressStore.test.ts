import { beforeEach, describe, expect, it } from "@effect/vitest";
import type { OrchestrationV2PlanStep } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  shellDecorationChangesAfter,
  shellDecorationCursor,
} from "../sessionBoxes/boxNamerCache.ts";
import {
  LIVE_PROGRESS_THREADS_MAX,
  applyLiveProgressReport,
  applyLiveProgressTodo,
  beginLiveProgressWork,
  liveProgressFor,
  resetLiveProgressStoreForTest,
  setLiveProgressEnabled,
  shellLiveProgress,
} from "./liveProgressStore.ts";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 10, 26, 23, 0, 0);
const THREAD = "thread-live-progress";

const report = (
  nowMs: number,
  body: Parameters<typeof applyLiveProgressReport>[0]["report"],
  extra: Partial<Parameters<typeof applyLiveProgressReport>[0]> = {},
) =>
  applyLiveProgressReport({ threadId: THREAD, workStartedAt: T0, nowMs, report: body, ...extra });

beforeEach(() => resetLiveProgressStoreForTest({ enabled: true }));

describe("applyLiveProgressReport", () => {
  it("keeps when each stage started, times finished ones and learns from them", () => {
    report(T0 + 30_000, {
      stages: [
        { title: "Read the code", status: "active", minutes: 4 },
        { title: "Build", status: "pending", minutes: 10 },
      ],
      update: "Reading the server first.",
    });
    // The first stage of the first report started with the work.
    expect(liveProgressFor(THREAD)?.stages[0]?.startedAt).toBe(T0);

    const second = report(T0 + 6 * MINUTE, {
      stages: [
        { title: "read the  code", status: "done" },
        { title: "Build", status: "active", minutes: 12 },
      ],
      update: "Server read; building now.",
    });
    expect(second.samples).toEqual([{ estimatedMinutes: 4, actualMinutes: 6 }]);
    expect(second.progress.stages).toEqual([
      { title: "read the code", status: "done", minutes: 4, durationMs: 6 * MINUTE },
      { title: "Build", status: "active", minutes: 12, startedAt: T0 + 6 * MINUTE },
    ]);
    // 12 minutes of building left from now.
    expect(second.progress.etaAt).toBe(T0 + 18 * MINUTE);

    // An update alone keeps the stages and their times; a stage seen done stays timed.
    const third = report(T0 + 9 * MINUTE, { update: "Tests pass." });
    expect(third.samples).toEqual([]);
    expect(third.progress.stages).toEqual(second.progress.stages);
    expect(third.progress.updates.map((update) => update.text)).toEqual([
      "Tests pass.",
      "Server read; building now.",
      "Reading the server first.",
    ]);
  });

  it("keeps five updates, skips a repeat and clips long text", () => {
    for (let index = 0; index < 7; index++)
      report(T0 + index * MINUTE, { update: `Update ${index}` });
    report(T0 + 8 * MINUTE, { update: "Update 6" });
    const last = report(T0 + 9 * MINUTE, { update: `${"word ".repeat(40)}end` });
    expect(last.progress.updates).toHaveLength(5);
    expect(last.progress.updates[1]?.text).toBe("Update 6");
    expect(last.progress.updates[0]?.text.length).toBeLessThanOrEqual(140);
    expect(last.progress.updates[0]?.text.endsWith("…")).toBe(true);
  });

  it("drops an old percent once new stages arrive, and never invents an ETA", () => {
    report(T0 + 10 * MINUTE, { percent: 40 });
    expect(liveProgressFor(THREAD)).toMatchObject({ percent: 40, etaAt: T0 + 25 * MINUTE });
    const staged = report(T0 + 11 * MINUTE, {
      stages: [{ title: "Polish", status: "active" }],
    });
    expect(staged.progress.percent).toBeUndefined();
    expect(staged.progress.etaAt).toBeUndefined();
  });

  it("applies the model's pace to the estimate it stores", () => {
    const applied = report(
      T0,
      { stages: [{ title: "Build", status: "pending", minutes: 10 }] },
      { pace: 1.5 },
    );
    expect(applied.progress).toMatchObject({ pace: 1.5, etaAt: T0 + 15 * MINUTE });
    expect(report(T0, { update: "x" }, { pace: 1 }).progress.pace).toBeUndefined();
  });

  it("starts over when the chat begins other work", () => {
    report(T0 + MINUTE, { update: "Old task" });
    beginLiveProgressWork(THREAD, T0);
    expect(liveProgressFor(THREAD)?.updates).toHaveLength(1);
    beginLiveProgressWork(THREAD, T0 + HOUR);
    expect(liveProgressFor(THREAD)).toBeUndefined();
  });
});

const HOUR = 60 * MINUTE;
const step = (
  text: string,
  status: OrchestrationV2PlanStep["status"],
  extra: Partial<OrchestrationV2PlanStep> = {},
): OrchestrationV2PlanStep => ({ id: text, text, status, ...extra });

describe("applyLiveProgressTodo", () => {
  it("turns the agent's own todo list into stages without minutes", () => {
    applyLiveProgressTodo({
      threadId: THREAD,
      workStartedAt: T0,
      nowMs: T0 + 8 * MINUTE,
      steps: [
        step("Read the spec", "completed", { durationMs: 3 * MINUTE }),
        step("Write the tool", "running", {
          durationAnchorAt: DateTime.formatIso(DateTime.makeUnsafe(T0 + 3 * MINUTE)),
        }),
        step("Draw the card", "pending"),
        step("Take screenshots", "pending"),
      ],
    });
    expect(liveProgressFor(THREAD)).toEqual({
      source: "todo",
      startedAt: T0,
      reportedAt: T0 + 8 * MINUTE,
      stages: [
        { title: "Read the spec", status: "done", durationMs: 3 * MINUTE },
        { title: "Write the tool", status: "active", startedAt: T0 + 3 * MINUTE },
        { title: "Draw the card", status: "pending" },
        { title: "Take screenshots", status: "pending" },
      ],
      updates: [],
      percent: 25,
    });
  });

  it("gives way to the agent's own reports", () => {
    applyLiveProgressTodo({
      threadId: THREAD,
      workStartedAt: T0,
      nowMs: T0,
      steps: [step("Plan", "running")],
    });
    report(T0 + MINUTE, { stages: [{ title: "Build", status: "active", minutes: 5 }] });
    applyLiveProgressTodo({
      threadId: THREAD,
      workStartedAt: T0,
      nowMs: T0 + 2 * MINUTE,
      steps: [step("Plan", "completed")],
    });
    expect(liveProgressFor(THREAD)?.source).toBe("report");
  });
});

describe("what shells see", () => {
  it("shows progress only at High token use and only while the chat works", () => {
    report(T0, { update: "Working on it." });
    expect(shellLiveProgress(THREAD, true).liveProgress?.updates[0]?.text).toBe("Working on it.");
    expect(shellLiveProgress(THREAD, false)).toEqual({});
    setLiveProgressEnabled(false);
    expect(shellLiveProgress(THREAD, true)).toEqual({});
  });

  it("re-sends a chat's shell when its progress changes or High turns off", () => {
    const before = shellDecorationCursor();
    report(T0, { update: "One" });
    expect(shellDecorationChangesAfter(before)?.threadIds).toContain(THREAD);
    const afterReport = shellDecorationCursor();
    setLiveProgressEnabled(false);
    expect(shellDecorationChangesAfter(afterReport)?.threadIds).toContain(THREAD);
    // While off, reports are kept but shells are not disturbed.
    const whileOff = shellDecorationCursor();
    report(T0 + MINUTE, { update: "Two" });
    expect(shellDecorationChangesAfter(whileOff)?.threadIds).toEqual([]);
  });

  it("remembers a bounded number of chats", () => {
    for (let index = 0; index <= LIVE_PROGRESS_THREADS_MAX; index++)
      applyLiveProgressReport({
        threadId: `thread-${index}`,
        workStartedAt: T0,
        nowMs: T0,
        report: { update: "Hi" },
      });
    expect(liveProgressFor("thread-0")).toBeUndefined();
    expect(liveProgressFor(`thread-${LIVE_PROGRESS_THREADS_MAX}`)).toBeDefined();
  });
});
