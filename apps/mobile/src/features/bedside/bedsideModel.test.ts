import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import {
  bedsideCanIdle,
  bedsideLeaveReason,
  bedsideOffset,
  bedsideSummaryParts,
  buildBedsideSnapshot,
  formatBedsideClock,
  formatBedsideDate,
  formatBedsideElapsed,
  localeUses24Hour,
  msUntilNextMinute,
} from "./bedsideModel";

const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const environmentId = EnvironmentId.make("environment-1");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function runtime(
  status: NonNullable<EnvironmentThreadShell["runtime"]>["status"],
  extra: Partial<NonNullable<EnvironmentThreadShell["runtime"]>> = {},
): EnvironmentThreadShell["runtime"] {
  return {
    status,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: null,
    lastError: null,
    updatedAt: minutesAgo(0),
    ...extra,
  };
}

function finishedRun(completedMinutesAgo: number): EnvironmentThreadShell["latestRun"] {
  return {
    runId: RunId.make("run"),
    status: "completed",
    requestedAt: minutesAgo(completedMinutesAgo + 5),
    startedAt: minutesAgo(completedMinutesAgo + 5),
    completedAt: minutesAgo(completedMinutesAgo),
    assistantMessageId: null,
  };
}

function thread(id: string, overrides: Partial<EnvironmentThreadShell> = {}) {
  return makeThreadShellFixture({
    environmentId,
    id: ThreadId.make(id),
    title: id,
    createdAt: minutesAgo(600),
    ...overrides,
  });
}

const working = (id: string, startedMinutesAgo: number) =>
  thread(id, {
    runtime: runtime("running", { activityStartedAt: minutesAgo(startedMinutesAgo) }),
    latestUserMessageAt: minutesAgo(startedMinutesAgo),
  });

const connected: ReadonlyMap<string, EnvironmentConnectionPhase> = new Map([
  [environmentId, "connected"],
]);

function snapshot(threads: ReadonlyArray<EnvironmentThreadShell>, phases = connected) {
  return buildBedsideSnapshot({ threads, now: NOW, connectionPhases: phases });
}

describe("buildBedsideSnapshot", () => {
  it("orders needs you, failed, working newest first, then recently finished", () => {
    const result = snapshot([
      thread("done", { latestRun: finishedRun(3) }),
      working("older-work", 30),
      thread("question", { hasPendingUserInput: true }),
      thread("failed", {
        runtime: runtime("failed"),
        latestRun: finishedRun(10),
        lastVisitedAt: minutesAgo(20),
      }),
      working("newer-work", 12),
    ]);
    expect(result.rows.map((row) => [row.thread.title, row.state, row.label])).toEqual([
      ["question", "needsYou", "Needs you"],
      ["failed", "failed", "Failed"],
      ["newer-work", "working", "12m"],
      ["older-work", "working", "30m"],
      ["done", "finished", "Done 3m"],
    ]);
    expect(result).toMatchObject({ more: 0, needsYou: 1, working: 2 });
  });

  it("counts approvals as needing the user and caps the rows", () => {
    const result = snapshot([
      thread("approval", { hasPendingApprovals: true }),
      ...[1, 2, 3, 4, 5, 6].map((minutes) => working(`work-${minutes}`, minutes)),
    ]);
    expect(result.rows).toHaveLength(5);
    expect(result.rows[0]?.state).toBe("needsYou");
    expect(result).toMatchObject({ more: 2, needsYou: 1, working: 6 });
  });

  it("leaves out old, opened, hidden and disconnected chats", () => {
    const result = snapshot(
      [
        thread("finished-long-ago", { latestRun: finishedRun(61) }),
        thread("failure-already-seen", {
          runtime: runtime("failed"),
          latestRun: finishedRun(10),
          lastVisitedAt: minutesAgo(5),
        }),
        thread("archived", { hasPendingUserInput: true, archivedAt: minutesAgo(1) }),
        thread("subagent", {
          hasPendingUserInput: true,
          lineage: {
            rootThreadId: ThreadId.make("root"),
            parentThreadId: ThreadId.make("root"),
            relationshipToParent: "subagent",
          },
        }),
        thread("offline-work", {
          environmentId: EnvironmentId.make("offline"),
          runtime: runtime("running"),
        }),
        thread("never-ran"),
      ],
      new Map([
        [environmentId, "connected"],
        [EnvironmentId.make("offline"), "offline"],
      ]),
    );
    expect(result).toEqual({ rows: [], more: 0, needsYou: 0, working: 0 });
  });

  it("labels work without a known start blank and a just-finished turn as now", () => {
    const result = snapshot([
      thread("work", { runtime: runtime("running") }),
      thread("done", { latestRun: finishedRun(0) }),
    ]);
    expect(result.rows.map((row) => row.label)).toEqual(["", "Done now"]);
  });

  it("counts waiting from the subagent's start when supplied by the server", () => {
    const waiting = {
      latestRun: finishedRun(180),
      runtime: runtime("idle"),
    };
    const result = snapshot([
      thread("late-subagent", {
        ...waiting,
        pendingBackgroundTasks: [{ taskId: "child", kind: "subagent", startedAt: minutesAgo(0) }],
      }),
      thread("legacy-server", {
        ...waiting,
        pendingBackgroundTasks: [{ taskId: "child", kind: "subagent" }],
      }),
    ]);
    expect(result.rows.map((row) => [row.thread.title, row.label])).toEqual([
      ["late-subagent", "<1m"],
      ["legacy-server", "3h"],
    ]);
  });
});

describe("formatBedsideElapsed", () => {
  it("writes minutes, then hours and minutes", () => {
    expect(
      [0, 59_000, 12 * 60_000, 60 * 60_000, 65 * 60_000, 26 * 3_600_000].map(formatBedsideElapsed),
    ).toEqual(["<1m", "<1m", "12m", "1h", "1h 5m", "26h"]);
  });
});

describe("bedsideSummaryParts", () => {
  it("leaves out zero parts and is empty when all quiet", () => {
    expect(bedsideSummaryParts({ needsYou: 2, working: 3 })).toEqual([
      { tone: "attention", text: "2 need you" },
      { tone: "working", text: "3 working" },
    ]);
    expect(bedsideSummaryParts({ needsYou: 1, working: 0 })).toEqual([
      { tone: "attention", text: "1 needs you" },
    ]);
    expect(bedsideSummaryParts({ needsYou: 0, working: 1 })).toEqual([
      { tone: "working", text: "1 working" },
    ]);
    expect(bedsideSummaryParts({ needsYou: 0, working: 0 })).toEqual([]);
  });
});

describe("clock", () => {
  it("formats 12- and 24-hour time without seconds", () => {
    expect(formatBedsideClock(new Date(2026, 10, 14, 0, 5, 59), false)).toEqual({
      time: "12:05",
      period: "AM",
    });
    expect(formatBedsideClock(new Date(2026, 10, 14, 21, 7), false)).toEqual({
      time: "9:07",
      period: "PM",
    });
    expect(formatBedsideClock(new Date(2026, 10, 14, 9, 7), true)).toEqual({
      time: "09:07",
      period: null,
    });
  });

  it("follows the locale's hour cycle and writes the date", () => {
    expect(localeUses24Hour("en-US")).toBe(false);
    expect(localeUses24Hour("de-DE")).toBe(true);
    expect(formatBedsideDate(new Date(2026, 10, 14), "en-US")).toBe("Saturday, November 14");
  });

  it("ticks on the next minute boundary", () => {
    expect(msUntilNextMinute(Date.parse("2026-11-14T12:00:45.000Z"))).toBe(15_000);
    expect(msUntilNextMinute(Date.parse("2026-11-14T12:00:00.000Z"))).toBe(60_000);
  });
});

describe("bedsideOffset", () => {
  it("cycles through eight distinct offsets within 10 points", () => {
    const offsets = Array.from({ length: 8 }, (_, step) => bedsideOffset(step));
    expect(new Set(offsets.map(({ x, y }) => `${x},${y}`)).size).toBe(8);
    for (const { x, y } of offsets) {
      expect(Math.abs(x)).toBeLessThanOrEqual(10);
      expect(Math.abs(y)).toBeLessThanOrEqual(10);
    }
    expect(bedsideOffset(8)).toEqual(bedsideOffset(0));
  });
});

describe("enter and leave", () => {
  const ready = {
    enabled: true,
    charging: true,
    appActive: true,
    homeVisible: true,
    keyboardVisible: false,
  };

  it("idles in only while every condition holds", () => {
    expect(bedsideCanIdle(ready)).toBe(true);
    for (const key of ["enabled", "charging", "appActive", "homeVisible"] as const) {
      expect(bedsideCanIdle({ ...ready, [key]: false })).toBe(false);
    }
    expect(bedsideCanIdle({ ...ready, keyboardVisible: true })).toBe(false);
  });

  it("leaves on background, hidden Home and unplugging; a preview only on background", () => {
    expect(bedsideLeaveReason("idle", ready)).toBeNull();
    expect(bedsideLeaveReason("idle", { ...ready, appActive: false })).toBe("background");
    expect(bedsideLeaveReason("idle", { ...ready, homeVisible: false })).toBe("hidden");
    expect(bedsideLeaveReason("idle", { ...ready, enabled: false })).toBe("hidden");
    expect(bedsideLeaveReason("idle", { ...ready, charging: false })).toBe("unplugged");
    const unplugged = { ...ready, charging: false, homeVisible: false, enabled: false };
    expect(bedsideLeaveReason("preview", unplugged)).toBeNull();
    expect(bedsideLeaveReason("preview", { ...unplugged, appActive: false })).toBe("background");
  });
});
