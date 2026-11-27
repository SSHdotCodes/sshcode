import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationV2LiveProgress } from "@t3tools/contracts";

import {
  LIVE_PROGRESS_PACE_MAX,
  LIVE_PROGRESS_PACE_MIN,
  estimateLiveProgress,
  formatFinishClock,
  formatStageDuration,
  formatTimeLeft,
  formatUpdateAge,
  liveProgressCard,
  liveProgressPace,
} from "./liveProgress.ts";

const MINUTE = 60_000;
// Finish times use the viewer's zone; pin one so the expected clock text holds on any machine.
process.env.TZ = "America/New_York";
// 2026-11-26 6:00 PM ET.
const T0 = Date.UTC(2026, 10, 26, 23, 0, 0);

const progress = (
  overrides: Partial<OrchestrationV2LiveProgress> = {},
): OrchestrationV2LiveProgress => ({
  source: "report",
  startedAt: T0,
  reportedAt: T0,
  stages: [],
  updates: [],
  ...overrides,
});

describe("estimateLiveProgress", () => {
  it("adds pending minutes to what is left of the active stage, times the pace", () => {
    const report = progress({
      pace: 1.5,
      stages: [
        { title: "Read the code", status: "done", minutes: 2, durationMs: 3 * MINUTE },
        { title: "Build the server", status: "active", minutes: 10, startedAt: T0 },
        { title: "Phone screen", status: "pending", minutes: 4 },
      ],
    });
    const estimate = estimateLiveProgress(report, T0 + 5 * MINUTE);
    // Active: 10 × 1.5 − 5 = 10 min; pending: 4 × 1.5 = 6 min.
    expect(estimate.remainingMs).toBe(16 * MINUTE);
    expect(estimate.finishAt).toBe(T0 + 21 * MINUTE);
    expect(estimate.currentIndex).toBe(1);
    expect(estimate.stages[1]).toMatchObject({ remainingMs: 10 * MINUTE, elapsedMs: 5 * MINUTE });
    expect(estimate.stages[1]?.fraction).toBeCloseTo(1 / 3);
    expect(estimate.stages[2]).toMatchObject({
      remainingMs: 6 * MINUTE,
      finishAt: T0 + 21 * MINUTE,
    });
    expect(estimate.fraction).toBeCloseTo(5 / 21);
  });

  it("floors an overrunning active stage at one minute and keeps counting pending stages", () => {
    const report = progress({
      stages: [
        { title: "Tests", status: "active", minutes: 3, startedAt: T0 },
        { title: "Ship", status: "pending", minutes: 2 },
      ],
      reportedAt: T0 + 4 * MINUTE,
    });
    const estimate = estimateLiveProgress(report, T0 + 6 * MINUTE);
    expect(estimate.remainingMs).toBe(3 * MINUTE);
    expect(estimate.overdue).toBe(false);
  });

  it("drops the number once a silent stage runs far past its estimate", () => {
    const report = progress({
      stages: [{ title: "Tests", status: "active", minutes: 3, startedAt: T0 }],
    });
    const estimate = estimateLiveProgress(report, T0 + 20 * MINUTE);
    expect(estimate).toMatchObject({ remainingMs: null, fraction: null, overdue: true });
    expect(liveProgressCard(report, T0 + 20 * MINUTE).timeLeft).toBe("longer than estimated");
  });

  it("clamps the pace a store could have saved out of range", () => {
    const stages = [{ title: "Build", status: "pending" as const, minutes: 10 }];
    expect(estimateLiveProgress(progress({ stages, pace: 40 }), T0).remainingMs).toBe(
      10 * LIVE_PROGRESS_PACE_MAX * MINUTE,
    );
    expect(estimateLiveProgress(progress({ stages, pace: 0.01 }), T0).remainingMs).toBe(
      10 * LIVE_PROGRESS_PACE_MIN * MINUTE,
    );
  });

  it("has no estimate when any unfinished stage lacks minutes", () => {
    const report = progress({
      stages: [
        { title: "Plan", status: "active", minutes: 5, startedAt: T0 },
        { title: "Build", status: "pending" },
      ],
    });
    const estimate = estimateLiveProgress(report, T0 + MINUTE);
    expect(estimate).toMatchObject({ remainingMs: null, finishAt: null, fraction: null });
    expect(estimate.stages.map((stage) => stage.remainingMs)).toEqual([null, null]);
  });

  it("extrapolates a percent from elapsed time when there are no minutes", () => {
    const report = progress({ percent: 25, reportedAt: T0 + 10 * MINUTE });
    const estimate = estimateLiveProgress(report, T0 + 10 * MINUTE);
    expect(estimate.remainingMs).toBe(30 * MINUTE);
    expect(estimate.fraction).toBe(0.25);
  });

  it("will not extrapolate a tiny percent, a fresh run or a stale report", () => {
    expect(
      estimateLiveProgress(progress({ percent: 2, reportedAt: T0 + 10 * MINUTE }), T0 + 10 * MINUTE)
        .remainingMs,
    ).toBeNull();
    expect(
      estimateLiveProgress(progress({ percent: 50, reportedAt: T0 + 20_000 }), T0 + 20_000)
        .remainingMs,
    ).toBeNull();
    const stale = estimateLiveProgress(
      progress({ percent: 50, reportedAt: T0 + 4 * MINUTE }),
      T0 + 30 * MINUTE,
    );
    expect(stale).toMatchObject({ remainingMs: null, overdue: true });
  });

  it("caps believable estimates", () => {
    const report = progress({ stages: [{ title: "Train", status: "pending", minutes: 900 }] });
    expect(estimateLiveProgress(report, T0)).toMatchObject({ remainingMs: null, fraction: null });
  });

  it("has nothing to say without stages, minutes or percent", () => {
    const estimate = estimateLiveProgress(progress({ updates: [{ text: "Hi", at: T0 }] }), T0);
    expect(estimate).toMatchObject({ remainingMs: null, fraction: null, currentIndex: -1 });
  });

  it("is almost done once every stage is done", () => {
    const report = progress({ stages: [{ title: "Ship", status: "done", minutes: 2 }] });
    expect(estimateLiveProgress(report, T0 + MINUTE)).toMatchObject({
      remainingMs: 0,
      fraction: 1,
    });
    expect(liveProgressCard(report, T0 + MINUTE)).toMatchObject({
      timeLeft: "almost done",
      finishLabel: null,
      currentIndex: -1,
      title: "Ship",
    });
  });
});

describe("liveProgressPace", () => {
  it("starts at 1 and moves gently with a few samples", () => {
    expect(liveProgressPace([])).toBe(1);
    // (15 + 20) / (15 + 10)
    expect(liveProgressPace([{ estimatedMinutes: 10, actualMinutes: 20 }])).toBeCloseTo(1.4);
  });

  it("learns from many samples, within its bounds", () => {
    const slow = Array.from({ length: 20 }, () => ({ estimatedMinutes: 10, actualMinutes: 20 }));
    expect(liveProgressPace(slow)).toBeCloseTo((15 + 20 * 20) / (15 + 20 * 10));
    const slower = Array.from({ length: 20 }, () => ({ estimatedMinutes: 5, actualMinutes: 25 }));
    expect(liveProgressPace(slower)).toBe(LIVE_PROGRESS_PACE_MAX);
    const fast = Array.from({ length: 20 }, () => ({ estimatedMinutes: 10, actualMinutes: 1 }));
    expect(liveProgressPace(fast)).toBe(LIVE_PROGRESS_PACE_MIN);
  });

  it("caps a stage that ran far past its estimate and ignores broken samples", () => {
    // Capped at 4 × 2 + 5 = 13 minutes.
    expect(liveProgressPace([{ estimatedMinutes: 2, actualMinutes: 300 }])).toBeCloseTo(28 / 17);
    expect(
      liveProgressPace([
        { estimatedMinutes: 0, actualMinutes: 5 },
        { estimatedMinutes: Number.NaN, actualMinutes: 5 },
        { estimatedMinutes: Number.POSITIVE_INFINITY, actualMinutes: 5 },
        { estimatedMinutes: 5, actualMinutes: Number.POSITIVE_INFINITY },
      ]),
    ).toBe(1);
    expect(
      estimateLiveProgress(
        progress({
          pace: Number.NaN,
          stages: [{ title: "Build", status: "pending", minutes: 10 }],
        }),
        T0,
      ).remainingMs,
    ).toBe(10 * MINUTE);
  });
});

describe("formatting", () => {
  it("says time left in each place's voice", () => {
    expect(formatTimeLeft(12 * MINUTE)).toBe("about 12 min left");
    expect(formatTimeLeft(8 * MINUTE, "compact")).toBe("~8 min left");
    expect(formatTimeLeft(8 * MINUTE, "pill")).toBe("8 min left");
    expect(formatTimeLeft(45_000)).toBe("almost done");
    expect(formatTimeLeft(80 * MINUTE)).toBe("about 1 hr 20 min left");
    expect(formatTimeLeft(118 * MINUTE)).toBe("about 2 hr left");
    expect(formatStageDuration(4 * MINUTE + 10_000)).toBe("4m");
    expect(formatStageDuration(42_000)).toBe("42s");
    expect(formatStageDuration(65 * MINUTE)).toBe("1h 5m");
    expect(formatUpdateAge(T0, T0 + 30_000)).toBe("just now");
    expect(formatUpdateAge(T0, T0 + 2 * MINUTE + 5_000)).toBe("2m ago");
  });

  it("writes finish times on the local 12-hour clock", () => {
    expect(formatFinishClock(T0 + 45 * MINUTE + 20_000, T0)).toBe("6:45 PM");
    expect(formatFinishClock(T0 + 7 * MINUTE, T0)).toBe("6:07 PM");
  });
});

describe("liveProgressCard", () => {
  const report = progress({
    stages: [
      { title: "Read the code", status: "done", durationMs: 4 * MINUTE },
      { title: "Server tool", status: "done" },
      { title: "Mac card", status: "active", minutes: 10, startedAt: T0 + 5 * MINUTE },
      { title: "Phone card", status: "pending", minutes: 10 },
      { title: "Screenshots", status: "pending", minutes: 5 },
    ],
    updates: [
      { text: "Tests pass on the server; now building the phone screen.", at: T0 + 7 * MINUTE },
      { text: "Server tool works.", at: T0 + 5 * MINUTE },
      { text: "Read the spec.", at: T0 + MINUTE },
      { text: "Started.", at: T0 },
    ],
    reportedAt: T0 + 7 * MINUTE,
  });

  it("shows the active stage, its neighbours and the three newest updates", () => {
    const card = liveProgressCard(report, T0 + 9 * MINUTE);
    expect(card).toMatchObject({
      title: "Mac card",
      timeLeft: "about 21 min left",
      compactTimeLeft: "~21 min left",
      pillTimeLeft: "21 min left",
      finishLabel: "done around 6:30 PM",
      currentIndex: 2,
      collapsedRange: [1, 4],
      latestUpdate: "Tests pass on the server; now building the phone screen.",
    });
    expect(card.stages.map((stage) => stage.label)).toEqual([
      "4m",
      null,
      "~6 min",
      "~10 min",
      "~5 min",
    ]);
    expect(card.stages[3]?.finishLabel).toBe("done around 6:25 PM");
    expect(card.updates.map(({ text, age }) => ({ text, age }))).toEqual([
      { text: "Tests pass on the server; now building the phone screen.", age: "2m ago" },
      { text: "Server tool works.", age: "4m ago" },
      { text: "Read the spec.", age: "8m ago" },
    ]);
  });

  it("draws an indeterminate bar and no time without an estimate", () => {
    const card = liveProgressCard(
      progress({
        source: "todo",
        stages: [
          { title: "Plan", status: "active", startedAt: T0 },
          { title: "Build", status: "pending" },
        ],
      }),
      T0 + MINUTE,
    );
    expect(card).toMatchObject({
      title: "Plan",
      timeLeft: null,
      compactTimeLeft: null,
      finishLabel: null,
      fraction: null,
    });
    expect(card.stages.map((stage) => stage.label)).toEqual([null, null]);
  });
});
