import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { RecordedUsageLimitReading } from "../src/provider/usageLimitRecorder.ts";
import { backtestUsageLimits } from "./usage-limit-backtest.ts";

const HOUR = 3_600_000;
const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const row = (
  hour: number,
  usedPercent: number,
  overrides: Partial<RecordedUsageLimitReading> = {},
): RecordedUsageLimitReading => ({
  driver: ProviderDriverKind.make("codex"),
  instanceId: "anonymous",
  windowId: "weekly",
  kind: "weekly",
  windowDurationMins: 8 * 60,
  usedPercent,
  checkedAt: iso(hour * HOUR),
  resetsAt: iso(8 * HOUR),
  recentPercentPerHour: 100,
  ...overrides,
});

describe("usage limit forecast backtest", () => {
  it("replays the shipped forecast at 25/50/75% used and compares simple alternatives", () => {
    const report = backtestUsageLimits(
      [row(0, 0), row(1, 25), row(2, 50), row(3, 75), row(4, 100), row(7.9, 100)],
      9 * HOUR,
    );
    const current = report.scores.filter(
      (score) => score.rule === "current" && score.axis === "used",
    );
    expect(current.map((score) => score.checkpoint)).toEqual([25, 50, 75]);
    expect(current.map((score) => score.medianErrorHours)).toEqual([-2.25, -1.5, -0.75]);
    expect(current.map((score) => score.medianAbsoluteErrorHours)).toEqual([2.25, 1.5, 0.75]);
    expect(
      report.scores
        .filter((score) => score.rule === "average" && score.axis === "used")
        .map((score) => score.medianAbsoluteErrorHours),
    ).toEqual([0, 0, 0]);
    expect(report.finishedWindows).toBe(1);
  });

  it("counts false alarms for windows observed lasting to reset instead of inventing exhaustion", () => {
    const report = backtestUsageLimits(
      [row(0, 0), row(1, 25), row(2, 50), row(3, 75), row(7.9, 80)],
      9 * HOUR,
    );
    const current = report.scores.find(
      (score) => score.axis === "used" && score.rule === "current",
    );
    expect(current).toMatchObject({
      falseAlarms: 1,
      timedPredictions: 0,
      medianErrorHours: null,
      medianAbsoluteErrorHours: null,
    });
  });

  it("does not score open windows, unobserved checkpoints, or interrupted counters", () => {
    expect(backtestUsageLimits([row(1, 25)], 2 * HOUR).finishedWindows).toBe(0);
    const partial = backtestUsageLimits([row(3, 75), row(4, 100)], 9 * HOUR);
    expect(partial.scores.find((score) => score.checkpoint === 25)?.timedPredictions ?? 0).toBe(0);
    const interrupted = backtestUsageLimits(
      [row(0, 0), row(1, 25), row(2, 50), row(3, 0), row(4, 100)],
      9 * HOUR,
    );
    expect(interrupted.finishedWindows).toBe(0);
  });

  it("isolates instances and windows, tolerates reset jitter, and treats explicit unlimited as censored", () => {
    const rows = [
      row(0, 0),
      row(1, 25),
      row(2, 50),
      row(3, 75),
      row(4, 100, { limited: false, resetsAt: iso(8 * HOUR + 30_000) }),
      row(7.9, 100, { limited: false }),
    ];
    const report = backtestUsageLimits(
      rows.concat(
        rows.map((entry) => ({
          ...entry,
          instanceId: "another",
          driver: ProviderDriverKind.make("claudeAgent"),
        })),
      ),
      9 * HOUR,
    );
    expect(report.finishedWindows).toBe(2);
    expect(new Set(report.scores.map((score) => score.driver))).toEqual(
      new Set(["codex", "claudeAgent"]),
    );
    expect(report.scores.every((score) => score.timedPredictions === 0)).toBe(true);
  });

  it("uses only readings available at elapsed checkpoints, including their staleness", () => {
    const report = backtestUsageLimits(
      [row(0, 0), row(1.95, 50), row(3.95, 80), row(5.95, 95), row(7, 100)],
      9 * HOUR,
    );
    expect(
      report.scores
        .filter((score) => score.axis === "elapsed" && score.rule === "current")
        .map((score) => score.timedPredictions),
    ).toEqual([1, 1, 1]);
    const sparse = backtestUsageLimits([row(0, 0), row(1, 25), row(7, 100)], 9 * HOUR);
    expect(
      sparse.scores
        .filter((score) => score.axis === "elapsed")
        .every((score) => score.timedPredictions === 0),
    ).toBe(true);
  });

  it("reports the collection horizon when no archive exists", () => {
    const report = backtestUsageLimits([], 0);
    expect(report.estimatedMoreDays).toBe(21);
    expect(report.scores).toEqual([]);
  });
});
