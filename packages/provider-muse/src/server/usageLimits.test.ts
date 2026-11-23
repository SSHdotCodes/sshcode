import { describe, expect, it } from "vite-plus/test";

import { museUsageJsonToAccount, recallMuseWeek, rememberMuseWeek } from "./usageLimits.ts";

const checkedAt = "2026-11-15T04:00:00.000Z";

describe("museUsageJsonToAccount", () => {
  it("reads the five-hour and weekly windows and the plan name", () => {
    const account = museUsageJsonToAccount(
      JSON.stringify({
        schemaVersion: 1,
        allowance: {
          tier: "Muse Code Power Usage",
          window: { usedPercent: 5, resetsAtMs: 1794733115000 },
          weekly: { usedPercent: 1, resetsAtMs: 1794787200000 },
          asOfMs: 1794715590688,
          source: "mint",
        },
        reason: null,
        hint: null,
      }),
      checkedAt,
    );
    expect(account.tier).toBe("Muse Code Power Usage");
    expect(account.usageLimits).toEqual({
      checkedAt,
      windows: [
        {
          id: "session",
          kind: "session",
          label: "Session",
          windowDurationMins: 300,
          usedPercent: 5,
          resetsAt: "2026-11-15T08:58:35.000Z",
        },
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          windowDurationMins: 10_080,
          usedPercent: 1,
          resetsAt: "2026-11-16T00:00:00.000Z",
        },
      ],
    });
  });

  it("clamps readings and keeps a window that has no reset time", () => {
    const { usageLimits } = museUsageJsonToAccount(
      JSON.stringify({ allowance: { window: { usedPercent: 140 }, weekly: null } }),
      checkedAt,
    );
    expect(usageLimits.windows).toEqual([
      {
        id: "session",
        kind: "session",
        label: "Session",
        windowDurationMins: 300,
        usedPercent: 100,
      },
    ]);
  });

  it("says an API key has no allowance to show", () => {
    expect(
      museUsageJsonToAccount(JSON.stringify({ allowance: null, reason: "api_key" }), checkedAt)
        .usageLimits.unavailable,
    ).toEqual({ reason: "unsupported" });
  });

  it("reads no numbers as an unused window beside the last reading's week", () => {
    const stdout = JSON.stringify({ allowance: null, reason: "server_sent_no_usage" });
    const session = {
      id: "session",
      kind: "session" as const,
      label: "Session",
      windowDurationMins: 300,
      usedPercent: 0,
    };
    const fresh = museUsageJsonToAccount(stdout, checkedAt);
    expect(fresh.unused).toBe(true);
    expect(fresh.usageLimits).toEqual({ checkedAt, windows: [session] });

    const week = (resetsAt: string) => ({
      id: "weekly",
      kind: "weekly" as const,
      label: "Weekly",
      windowDurationMins: 10_080,
      usedPercent: 23,
      resetsAt,
    });
    const last = (resetsAt: string) => ({
      tier: "Muse Code Power Usage",
      usageLimits: {
        checkedAt: "2026-11-15T03:00:00.000Z",
        windows: [{ ...session, usedPercent: 69 }, week(resetsAt)],
      },
    });
    const carried = museUsageJsonToAccount(stdout, checkedAt, last("2026-11-16T00:00:00.000Z"));
    expect(carried.tier).toBe("Muse Code Power Usage");
    expect(carried.usageLimits.windows).toEqual([session, week("2026-11-16T00:00:00.000Z")]);
    // A week that has ended has no reading to carry.
    expect(
      museUsageJsonToAccount(stdout, checkedAt, last("2026-11-15T03:30:00.000Z")).usageLimits
        .windows,
    ).toEqual([session]);
  });

  it("treats a missing reading as a failed check, so the last bars stay", () => {
    for (const stdout of [
      JSON.stringify({ allowance: null, reason: "something_else" }),
      JSON.stringify({ allowance: { tier: "Muse Code Power Usage" } }),
      "not json",
      "",
    ]) {
      expect(museUsageJsonToAccount(stdout, checkedAt).usageLimits.unavailable).toEqual({
        reason: "probeFailed",
      });
    }
  });
});

describe("the week across a restart", () => {
  const numbered = (weeklyUsed: number) =>
    museUsageJsonToAccount(
      JSON.stringify({
        allowance: {
          tier: "Muse Code Power Usage",
          window: { usedPercent: 29, resetsAtMs: 1794733115000 },
          weekly: { usedPercent: weeklyUsed, resetsAtMs: 1794787200000 },
        },
        reason: null,
      }),
      checkedAt,
    );
  const unusedStdout = JSON.stringify({ allowance: null, reason: "server_sent_no_usage" });

  it("gives an unused window its week and plan name back from what was saved", () => {
    const saved = rememberMuseWeek(numbered(33));
    expect(saved).toBeDefined();
    const recalled = recallMuseWeek(saved!.contents);
    const afterRestart = museUsageJsonToAccount(unusedStdout, "2026-11-15T05:00:00.000Z", recalled);
    expect(afterRestart.tier).toBe("Muse Code Power Usage");
    expect(afterRestart.usageLimits.windows).toEqual([
      { id: "session", kind: "session", label: "Session", windowDurationMins: 300, usedPercent: 0 },
      numbered(33).usageLimits.windows.find((candidate) => candidate.id === "weekly"),
    ]);
    // What was read back saves under the same key, so a start does not rewrite the file.
    expect(rememberMuseWeek(recalled!)?.key).toBe(saved!.key);
  });

  it("drops a saved week once it has reset", () => {
    const recalled = recallMuseWeek(rememberMuseWeek(numbered(33))!.contents);
    const nextWeek = museUsageJsonToAccount(unusedStdout, "2026-11-16T06:00:00.000Z", recalled);
    expect(nextWeek.usageLimits.windows.map((candidate) => candidate.id)).toEqual(["session"]);
  });

  it("changes its key only when the week or the plan does", () => {
    expect(rememberMuseWeek(numbered(33))!.key).toBe(rememberMuseWeek(numbered(33))!.key);
    expect(rememberMuseWeek(numbered(34))!.key).not.toBe(rememberMuseWeek(numbered(33))!.key);
  });

  it("saves nothing from a reading without numbers and reads nothing from a broken file", () => {
    expect(rememberMuseWeek(museUsageJsonToAccount(unusedStdout, checkedAt))).toBeUndefined();
    expect(rememberMuseWeek(museUsageJsonToAccount("not json", checkedAt))).toBeUndefined();
    expect(recallMuseWeek("{")).toBeUndefined();
    expect(recallMuseWeek(JSON.stringify({ weekly: { usedPercent: "many" } }))).toBeUndefined();
  });
});
