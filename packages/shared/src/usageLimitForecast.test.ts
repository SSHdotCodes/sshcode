// @effect-diagnostics globalDate:off -- Local wall-clock instants keep the phrasing the same in every zone.
import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  borrowedPoolForecast,
  describeLimitForecast,
  headlineWindows,
  limitForecast,
  poolForecast,
  limitPaceWarning,
  recentUsageRunOut,
  usageWindowForecast,
} from "./usageLimitForecast.ts";
import { collectLimitPools, type LimitAccount } from "./usageLimits.ts";

describe("forecast", () => {
  // Local times, so the phrasing reads the same in every time zone.
  const at = (day: number, hour: number, minute = 0) =>
    new Date(2026, 9, day, hour, minute).getTime();
  // Friday Oct 16, 11 PM.
  const friday = at(16, 23);
  const clock = (ms: number) => {
    const date = new Date(ms);
    return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
  };
  const claude = (windows: LimitAccount["limits"]["windows"], key = "a"): LimitAccount => ({
    key,
    sourceKeys: [],
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: key,
    primary: true,
    email: undefined,
    plan: undefined,
    accentColor: undefined,
    environments: [],
    sourceLabel: null,
    redeem: null,
    limits: { checkedAt: new Date(friday).toISOString(), windows },
  });
  const session = (usedPercent: number, resetsAt: number) => ({
    id: "five_hour",
    kind: "session" as const,
    label: "Session",
    usedPercent,
    windowDurationMins: 300,
    resetsAt: new Date(resetsAt).toISOString(),
  });
  const weekly = (usedPercent: number, resetsAt: number, windowDurationMins?: number) => ({
    id: "seven_day",
    kind: "weekly" as const,
    label: "Weekly",
    usedPercent,
    ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
    resetsAt: new Date(resetsAt).toISOString(),
  });
  const pool = (accounts: readonly LimitAccount[]) => collectLimitPools(accounts, friday)[0]!;

  it("runs out Monday evening at 48% two and a half days into the week", () => {
    // Opened Wednesday 8 AM, resets the next Wednesday at 8 AM.
    const { windows } = pool([claude([session(10, at(17, 2)), weekly(48, at(21, 8), 10080)])]);
    const forecast = poolForecast(windows, friday);
    expect(forecast).toMatchObject({ kind: "runsOut", windowId: "seven_day" });
    expect(describeLimitForecast(forecast!, friday, clock)).toEqual({
      text: "At this pace you'll run out Monday evening, before Wednesday's reset.",
      warn: true,
    });
    // The session window spends 5% an hour with 90% left, so it outlasts its reset.
    expect(limitForecast(windows[0]!, friday)).toMatchObject({ kind: "lasts" });
  });

  it("speaks for the longest window when every window lasts", () => {
    const { windows } = pool([claude([session(10, at(17, 2)), weekly(20, at(21, 8), 10080)])]);
    const forecast = poolForecast(windows, friday)!;
    expect(describeLimitForecast(forecast, friday, clock)).toEqual({
      text: "On pace to make it to Wednesday's reset.",
      warn: false,
    });
  });

  it("phrases a session that empties within the hour and a spent window", () => {
    const { windows } = pool([claude([session(90, at(17, 1))])]);
    // 90% in three hours leaves 10% for 20 minutes, before the 1 AM reset.
    expect(describeLimitForecast(poolForecast(windows, friday)!, friday, clock).text).toBe(
      "At this pace you'll run out in about 20m, before the 1:00 reset.",
    );
    const spent = pool([claude([session(100, at(16, 23, 30))])]);
    expect(describeLimitForecast(poolForecast(spent.windows, friday)!, friday, clock).text).toBe(
      "Limit reached until the 23:30 reset.",
    );
  });

  it("leads a Google plan with Gemini and warns about the shared Claude & GPT pool apart", () => {
    const google: LimitAccount = {
      ...claude([
        { ...weekly(26, at(21, 8), 10080), id: "gemini-weekly", label: "Gemini · Weekly" },
        {
          ...weekly(50, at(21, 8), 10080),
          id: "3p-weekly",
          label: "Claude & GPT (shared) · Weekly",
        },
      ]),
      driver: ProviderDriverKind.make("antigravity"),
    };
    const { windows } = pool([google]);
    // Across both pools the shared one runs dry first; the headline speaks for Gemini.
    expect(poolForecast(windows, friday)).toMatchObject({ windowId: "3p-weekly" });
    const own = headlineWindows("antigravity", windows);
    expect(own.map((window) => window.id)).toEqual(["gemini-weekly"]);
    expect(poolForecast(own, friday)).toMatchObject({ kind: "lasts", windowId: "gemini-weekly" });
    const shared = windows.find((window) => window.id === "3p-weekly")!;
    expect(borrowedPoolForecast("antigravity", shared, friday)).toMatchObject({ kind: "runsOut" });
    // Gemini's own limit and other providers' limits never get the shared-pool line.
    expect(borrowedPoolForecast("antigravity", own[0]!, friday)).toBeNull();
    expect(headlineWindows("claudeAgent", windows)).toHaveLength(2);
  });

  it("waits for a tenth of the window before projecting", () => {
    // Opened at 10:45 PM: a quarter hour into five hours.
    const { windows } = pool([claude([session(30, at(17, 3, 45))])]);
    expect(poolForecast(windows, friday)).toBeNull();
  });

  it("uses the recent burst when the weekly average would promise enough room", () => {
    const window = { ...weekly(87, at(17, 9)), recentPercentPerHour: 12 };
    expect(usageWindowForecast({ ...window, recentPercentPerHour: undefined }, friday)?.kind).toBe(
      "lasts",
    );
    const forecast = usageWindowForecast(window, friday)!;
    expect(forecast).toMatchObject({
      kind: "runsOut",
      pace: "recent",
      at: friday + (13 / 12) * 3_600_000,
    });
    expect(describeLimitForecast(forecast, friday, clock)).toEqual({
      text: "At the last hour's pace you'll run out around 0:05, before the 9:00 reset.",
      warn: true,
    });
    expect(poolForecast(pool([claude([window])]).windows, friday)).toEqual(forecast);
  });

  it("keeps a faster average and its existing wording", () => {
    const forecast = usageWindowForecast(
      { ...session(90, at(17, 1)), recentPercentPerHour: 12 },
      friday,
    )!;
    expect(forecast).toMatchObject({ kind: "runsOut", pace: "average" });
    expect(describeLimitForecast(forecast, friday, clock).text).toBe(
      "At this pace you'll run out in about 20m, before the 1:00 reset.",
    );
  });

  it("lets measured recent pace speak while the average is still guarded", () => {
    const window = { ...weekly(87, friday + 167 * 3_600_000), recentPercentPerHour: 12 };
    expect(usageWindowForecast({ ...window, recentPercentPerHour: undefined }, friday)).toBeNull();
    expect(usageWindowForecast(window, friday)).toMatchObject({ kind: "runsOut", pace: "recent" });
    expect(
      usageWindowForecast({ ...window, kind: "other", windowDurationMins: 0 }, friday),
    ).toMatchObject({ kind: "runsOut", pace: "recent" });
  });

  it("uses each pooled account's faster pace", () => {
    const windows = pool([
      claude([{ ...weekly(87, at(17, 9)), recentPercentPerHour: 12 }], "a"),
      claude([{ ...weekly(87, at(17, 9)), recentPercentPerHour: 24 }], "b"),
    ]).windows;
    expect(poolForecast(windows, friday)).toMatchObject({
      kind: "runsOut",
      pace: "recent",
      at: friday + (13 / 18) * 3_600_000,
    });
  });

  it.each([undefined, 0, -1, Infinity, NaN])(
    "ignores an unusable recent pace: %s",
    (recentPercentPerHour) => {
      expect(
        usageWindowForecast({ ...weekly(87, at(17, 9)), recentPercentPerHour }, friday)?.kind,
      ).toBe("lasts");
      expect(
        recentUsageRunOut({ ...weekly(87, at(17, 9)), recentPercentPerHour }, friday),
      ).toBeNull();
    },
  );

  it("warns only at 70% or more and within two hours of empty", () => {
    const window = { ...weekly(87, at(17, 9)), recentPercentPerHour: 12 };
    const warning = limitPaceWarning(window, friday);
    expect(warning?.at).toBe(friday + (13 / 12) * 3_600_000);
    // The reported reset wobbles by seconds between readings: still the same period.
    const wobbled = {
      ...window,
      resetsAt: new Date(Date.parse(window.resetsAt!) + 2_000).toISOString(),
    };
    expect(limitPaceWarning(wobbled, friday)?.resetKey).toBe(warning?.resetKey);
    expect(limitPaceWarning({ ...window, recentPercentPerHour: 6 }, friday)).toBeNull();
    expect(
      limitPaceWarning({ ...weekly(60, at(17, 9)), recentPercentPerHour: 30 }, friday),
    ).toBeNull();
    expect(limitPaceWarning(weekly(87, at(17, 9)), friday)).toBeNull();
  });

  it("only projects a recent run-out before an active reset", () => {
    const window = { ...weekly(87, at(17, 9)), recentPercentPerHour: 12 };
    expect(recentUsageRunOut(window, friday)).toBe(friday + (13 / 12) * 3_600_000);
    expect(
      recentUsageRunOut({ ...window, resetsAt: new Date(friday).toISOString() }, friday),
    ).toBeNull();
    expect(
      recentUsageRunOut(
        { ...window, resetsAt: new Date(friday + 3_600_000).toISOString() },
        friday,
      ),
    ).toBeNull();
    expect(recentUsageRunOut({ ...window, limited: true }, friday)).toBeNull();
    expect(recentUsageRunOut({ ...window, usedPercent: 100 }, friday)).toBeNull();
  });

  it.each([99.1, 99.6, 100])(
    "warns instead of claiming an allowed %s%% window is spent",
    (usedPercent) => {
      const { windows } = pool([claude([{ ...weekly(usedPercent, at(17, 14)), limited: false }])]);
      const forecast = poolForecast(windows, friday)!;
      expect(forecast.kind).toBe("almostOut");
      expect(describeLimitForecast(forecast, friday, clock)).toEqual({
        text: "Almost out: under 1% left until tomorrow's reset.",
        warn: true,
      });
    },
  );

  it("uses a rejected verdict even if utilization is below 100", () => {
    const { windows } = pool([claude([{ ...weekly(99.6, at(17, 14)), limited: true }])]);
    const forecast = poolForecast(windows, friday)!;
    expect(forecast.kind).toBe("out");
    expect(describeLimitForecast(forecast, friday, clock)).toEqual({
      text: "Limit reached until tomorrow's reset.",
      warn: true,
    });
  });

  it("only calls a pool spent once every account is spent", () => {
    const { windows } = pool([
      claude([{ ...weekly(100, at(17, 14)), limited: true }], "a"),
      claude([{ ...weekly(100, at(17, 14)), limited: false }], "b"),
    ]);
    expect(poolForecast(windows, friday)?.kind).toBe("almostOut");
  });

  it("does not call a pool spent when an untimed account still allows requests", () => {
    const { windows } = pool([
      claude([{ ...weekly(100, at(17, 14)), limited: true }], "a"),
      claude(
        [{ id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 50, limited: false }],
        "b",
      ),
    ]);
    expect(poolForecast(windows, friday)).toBeNull();
  });

  it("does not forecast the whole pool from one reading when another is older or untimed", () => {
    const live = claude([weekly(100, at(21, 8))], "a");
    const room = weekly(20, at(21, 8));
    const { resetsAt: _reset, ...untimed } = room;
    for (const account of [
      { ...claude([room], "b"), asOf: at(16, 19) },
      claude([untimed], "b"),
      claude([weekly(20, at(16, 22))], "b"),
    ]) {
      expect(poolForecast(pool([live, account]).windows, friday)).toBeNull();
    }
    const spending = claude([weekly(90, at(21, 8))], "a");
    expect(poolForecast(pool([spending, claude([untimed], "b")]).windows, friday)).toBeNull();
  });

  it("does not project more spending on an account that is already at its limit", () => {
    const { windows } = pool([
      claude([weekly(100, at(21, 8))], "a"),
      claude([weekly(25, at(21, 8))], "b"),
    ]);
    expect(poolForecast(windows, friday)).toMatchObject({ kind: "lasts", resetsAt: at(21, 8) });
  });

  it("leads with a reached window before an almost empty one", () => {
    const { windows } = pool([
      claude([
        { ...session(100, at(17, 1)), limited: false },
        { ...weekly(100, at(17, 14)), limited: true },
      ]),
    ]);
    expect(poolForecast(windows, friday)).toMatchObject({ kind: "out", windowId: "seven_day" });
  });

  it("assumes the usual length for a weekly window that reports none, but not for other kinds", () => {
    const { windows } = pool([claude([weekly(48, at(21, 8))])]);
    expect(limitForecast(windows[0]!, friday)).toMatchObject({ kind: "runsOut" });
    const other = pool([claude([{ ...weekly(48, at(21, 8)), kind: "other" as const }])]);
    expect(limitForecast(other.windows[0]!, friday)).toBeNull();
  });

  it("pools accounts and refills at the soonest reset", () => {
    // One account nearly spent, one barely used: the pool lasts to the earlier reset.
    const { windows } = pool([
      claude([weekly(90, at(21, 8), 10080)], "a"),
      claude([weekly(5, at(19, 8), 10080)], "b"),
    ]);
    expect(limitForecast(windows[0]!, friday)).toMatchObject({
      kind: "lasts",
      resetsAt: at(19, 8),
    });
  });

  it("dates a monthly reset more than a week out", () => {
    // Opened Oct 10, resets Nov 10: 10% in six and a half days lasts the month.
    const monthly = {
      id: "monthly",
      kind: "monthly" as const,
      label: "Monthly",
      usedPercent: 10,
      resetsAt: new Date(2026, 10, 10, 8).toISOString(),
    };
    const forecast = limitForecast(pool([claude([monthly])]).windows[0]!, friday)!;
    expect(forecast.kind).toBe("lasts");
    expect(describeLimitForecast(forecast, friday, clock).text).toBe(
      `On pace to make it to the ${new Date(2026, 10, 10).toLocaleDateString(undefined, { month: "short", day: "numeric" })} reset.`,
    );
  });
});
