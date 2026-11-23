// @effect-diagnostics globalDate:off -- Fixed instants for quota sampling.
import { ProviderInstanceId, type ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeUsageLimitHistory, recordUsageSample } from "./usageLimitHistory.ts";

const MINUTE = 60_000;
const instanceId = ProviderInstanceId.make("claude_personal");
const window: ServerProviderUsageWindow = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 75,
  resetsAt: "2026-11-11T12:00:00.000Z",
};
const reading = (
  minute: number,
  usedPercent = 75,
  overrides: Partial<ServerProviderUsageWindow> = {},
) => ({
  checkedAt: new Date(Date.parse("2026-11-10T12:00:00.000Z") + minute * MINUTE).toISOString(),
  windows: [{ ...window, usedPercent, ...overrides }],
});

describe("usage limit history", () => {
  it("measures the recent rise using the span nearest an hour", () => {
    const history = makeUsageLimitHistory();
    history.record(instanceId, reading(0, 60));
    history.record(instanceId, reading(30, 70));
    history.record(instanceId, reading(60, 75));
    expect(history.record(instanceId, reading(90, 87)).windows[0]?.recentPercentPerHour).toBe(17);
  });

  it("keeps measuring when the reported reset wobbles by seconds, and starts over on a real reset", () => {
    const history = makeUsageLimitHistory();
    history.record(instanceId, reading(0, 76, { resetsAt: "2026-11-11T11:59:58.412Z" }));
    expect(
      history.record(instanceId, reading(60, 87, { resetsAt: "2026-11-11T12:00:00.185Z" }))
        .windows[0]?.recentPercentPerHour,
    ).toBe(11);
    expect(
      history.record(instanceId, reading(120, 99, { resetsAt: "2026-11-18T12:00:00.000Z" }))
        .windows[0]?.recentPercentPerHour,
    ).toBeUndefined();
  });

  it.each([
    [14, 12, undefined],
    [29, 12, undefined],
    [30, 12, 24],
    [60, 0.9, undefined],
    [60, 1, 1],
    [90, 12, 8],
    [91, 12, undefined],
  ])("guards a %s minute span with a %s point rise", (minutes, rise, expected) => {
    const history = makeUsageLimitHistory();
    expect(history.record(instanceId, reading(0)).windows[0]?.recentPercentPerHour).toBeUndefined();
    expect(
      history.record(instanceId, reading(minutes, 75 + rise)).windows[0]?.recentPercentPerHour,
    ).toBe(expected);
  });

  it.each([{ usedPercent: 10 }, { resetsAt: "2026-11-18T12:00:00.000Z" }])(
    "starts fresh when a window resets: %j",
    (reset) => {
      const history = makeUsageLimitHistory();
      history.record(instanceId, reading(0));
      expect(history.record(instanceId, reading(60, 87)).windows[0]?.recentPercentPerHour).toBe(12);
      expect(
        history.record(instanceId, reading(65, 87, reset)).windows[0]?.recentPercentPerHour,
      ).toBeUndefined();
      const used = reset.usedPercent ?? 87;
      expect(
        history.record(instanceId, reading(125, used + 1, { ...reset, usedPercent: used + 1 }))
          .windows[0]?.recentPercentPerHour,
      ).toBe(1);
    },
  );

  describe("how far the limit rose each day", () => {
    const utcDay = (instant: number) => new Date(instant).toISOString().slice(0, 10);
    const thisWeek = "2026-11-11T12:00:00.000Z";
    const nextWeek = "2026-11-18T12:00:00.000Z";
    const at = (iso: string, usedPercent: number, resetsAt: string | undefined = thisWeek) => ({
      checkedAt: iso,
      windows: [{ ...window, usedPercent, resetsAt }],
    });
    const riseOf = (limits: { windows: ReadonlyArray<ServerProviderUsageWindow> }) =>
      limits.windows[0]?.dailyRise;

    it("counts across the resets a provider makes mid-week and at the week's end", () => {
      const history = makeUsageLimitHistory(utcDay);
      // The first reading is only a starting point: nobody saw that 1% accrue.
      expect(riseOf(history.record(instanceId, at("2026-11-08T12:00:00.000Z", 1)))).toEqual([]);
      history.record(instanceId, at("2026-11-08T20:00:00.000Z", 20));
      history.record(instanceId, at("2026-11-09T12:00:00.000Z", 60));
      history.record(instanceId, at("2026-11-09T23:30:00.000Z", 95));
      // Reset mid-week: the same week, the counter back at zero. Then again a day later.
      history.record(instanceId, at("2026-11-10T00:40:00.000Z", 0));
      history.record(instanceId, at("2026-11-10T22:30:00.000Z", 53));
      history.record(instanceId, at("2026-11-10T23:00:00.000Z", 5));
      history.record(instanceId, at("2026-11-11T10:00:00.000Z", 22));
      // The week ends at noon and the new one opens.
      history.record(instanceId, at("2026-11-11T13:00:00.000Z", 1, nextWeek));
      const rise = riseOf(history.record(instanceId, at("2026-11-11T17:00:00.000Z", 3, nextWeek)));
      expect(rise).toEqual([
        { day: "2026-11-08", percent: 19 },
        { day: "2026-11-09", percent: 75 },
        { day: "2026-11-10", percent: 58 },
        { day: "2026-11-11", percent: 20 },
      ]);
      // 172 points in a week that "used 22%": what a guess from the window's start gets wrong.
      expect(rise?.reduce((sum, entry) => sum + entry.percent, 0)).toBe(172);
    });

    it("ignores rounding flicker and a sliding window easing off", () => {
      const history = makeUsageLimitHistory(utcDay);
      history.record(instanceId, at("2026-11-10T12:00:00.000Z", 60));
      history.record(instanceId, at("2026-11-10T12:10:00.000Z", 59));
      history.record(instanceId, at("2026-11-10T12:20:00.000Z", 60));
      expect(riseOf(history.record(instanceId, at("2026-11-10T12:30:00.000Z", 61)))).toEqual([
        { day: "2026-11-10", percent: 1 },
      ]);
      // Three points down is not a restart; the next rise counts from there.
      history.record(instanceId, at("2026-11-10T13:00:00.000Z", 58));
      expect(riseOf(history.record(instanceId, at("2026-11-10T13:30:00.000Z", 60)))).toEqual([
        { day: "2026-11-10", percent: 3 },
      ]);
    });

    it("does not take a rolling window's moving reset for a restart", () => {
      const history = makeUsageLimitHistory(utcDay);
      // The reset is always five hours after the reading.
      history.record(instanceId, at("2026-11-10T12:00:00.000Z", 10, "2026-11-10T17:00:00.000Z"));
      history.record(instanceId, at("2026-11-10T12:30:00.000Z", 14, "2026-11-10T17:30:00.000Z"));
      expect(
        riseOf(
          history.record(
            instanceId,
            at("2026-11-10T13:00:00.000Z", 14, "2026-11-10T18:00:00.000Z"),
          ),
        ),
      ).toEqual([{ day: "2026-11-10", percent: 4 }]);
    });

    it("carries on from the saved snapshot after a restart, without measuring a pace from it", () => {
      const before = makeUsageLimitHistory(utcDay);
      before.record(instanceId, at("2026-11-10T12:00:00.000Z", 40));
      const saved = before.record(instanceId, at("2026-11-10T13:00:00.000Z", 46));
      expect(riseOf(saved)).toEqual([{ day: "2026-11-10", percent: 6 }]);

      const after = makeUsageLimitHistory(utcDay);
      const first = after.record(instanceId, at("2026-11-10T13:40:00.000Z", 49), saved);
      expect(riseOf(first)).toEqual([{ day: "2026-11-10", percent: 9 }]);
      expect(first.windows[0]?.recentPercentPerHour).toBeUndefined();
    });

    it("does not count a rise nobody watched", () => {
      // Two days closed: the work may have happened on another machine.
      const saved = makeUsageLimitHistory(utcDay).record(
        instanceId,
        at("2026-11-08T12:00:00.000Z", 10),
      );
      const first = makeUsageLimitHistory(utcDay).record(
        instanceId,
        at("2026-11-10T13:00:00.000Z", 70),
        saved,
      );
      expect(riseOf(first)).toEqual([]);
      // Nor one on another account's counter.
      const other = { ...saved, credentialFingerprint: "someone-else" };
      expect(
        riseOf(
          makeUsageLimitHistory(utcDay).record(
            instanceId,
            at("2026-11-08T13:00:00.000Z", 70),
            other,
          ),
        ),
      ).toEqual([]);
    });

    it("keeps four weeks", () => {
      const history = makeUsageLimitHistory(utcDay);
      history.record(instanceId, at("2026-10-01T12:00:00.000Z", 10, undefined));
      history.record(instanceId, at("2026-10-01T18:00:00.000Z", 20, undefined));
      history.record(instanceId, at("2026-10-02T12:00:00.000Z", 30, undefined));
      // Readings a day apart for five more weeks.
      let latest = history.record(instanceId, at("2026-10-03T12:00:00.000Z", 31, undefined));
      for (let day = 4; day <= 38; day++) {
        const instant = Date.parse("2026-10-01T12:00:00.000Z") + (day - 1) * 24 * 60 * MINUTE;
        latest = history.record(instanceId, {
          checkedAt: new Date(instant).toISOString(),
          windows: [{ ...window, usedPercent: 31 + day, resetsAt: undefined }],
        });
      }
      const days = riseOf(latest)?.map((entry) => entry.day) ?? [];
      expect(days.length).toBeLessThanOrEqual(29);
      expect(days[0]! >= "2026-10-10").toBe(true);
      expect(days.at(-1)).toBe("2026-11-07");
    });
  });

  it("isolates instances, window ids, and changed credentials", () => {
    const history = makeUsageLimitHistory();
    history.record(instanceId, reading(0));
    expect(
      history.record(ProviderInstanceId.make("claude_work"), reading(60, 87)).windows[0]
        ?.recentPercentPerHour,
    ).toBeUndefined();
    expect(
      history.record(instanceId, reading(60, 87, { id: "five_hour" })).windows[0]
        ?.recentPercentPerHour,
    ).toBeUndefined();
    expect(
      history.record(instanceId, reading(65, 88)).windows[0]?.recentPercentPerHour,
    ).toBeUndefined();
    expect(
      history.record(instanceId, { ...reading(125, 90), credentialFingerprint: "other-account" })
        .windows[0]?.recentPercentPerHour,
    ).toBeUndefined();
    history.clear(instanceId);
    expect(
      history.record(instanceId, reading(185, 95)).windows[0]?.recentPercentPerHour,
    ).toBeUndefined();
  });

  it("does not count repeated or out-of-order snapshots as new samples", () => {
    const first = recordUsageSample(undefined, window, 0);
    const repeated = recordUsageSample(first, window, 0);
    expect(repeated.samples).toHaveLength(1);
    expect(recordUsageSample(repeated, { ...window, usedPercent: 1 }, -1)).toBe(repeated);
  });

  it("keeps at most 64 samples and three hours per window", () => {
    let history = recordUsageSample(undefined, window, 0);
    for (let minute = 1; minute <= 64; minute++) {
      history = recordUsageSample(history, window, minute * MINUTE);
    }
    expect(history.samples).toHaveLength(64);
    expect(history.samples[0]?.checkedAt).toBe(MINUTE);
    history = recordUsageSample(history, window, 244 * MINUTE);
    expect(history.samples.map((sample) => sample.checkedAt)).toEqual([64 * MINUTE, 244 * MINUTE]);
  });

  it("does not restore a supplied pace without measured history", () => {
    const history = makeUsageLimitHistory();
    expect(
      history.record(instanceId, reading(0, 87, { recentPercentPerHour: 12 })).windows[0]
        ?.recentPercentPerHour,
    ).toBeUndefined();
  });

  it("retains an hour's span even with updates every second", () => {
    const history = makeUsageLimitHistory();
    let latest = history.record(instanceId, reading(0));
    for (let second = 1; second <= 3600; second++) {
      latest = history.record(instanceId, reading(second / 60, 75 + second / 300));
    }
    expect(latest.windows[0]?.recentPercentPerHour).toBe(12);
  });
});
