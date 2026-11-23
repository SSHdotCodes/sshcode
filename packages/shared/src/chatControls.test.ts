import { describe, expect, it } from "@effect/vitest";

import {
  QUIET_TURN_AFTER_MS,
  msUntilQuietTurn,
  quietTurnLabel,
  etCalendarDay,
  subagentBackgroundWaitLabel,
  isSubagentOrchestrationTool,
  longRunningFactsForShell,
  type LongRunningStatusInput,
  longRunningStatusLine,
  pinnedWaitingLine,
  subagentsOffConfirmation,
  subagentsToggleNeedsConfirm,
  SUBAGENT_ORCHESTRATION_TOOLS,
} from "./chatControls.ts";

/** 2026-11-06 is EST (UTC-5). Midnight in New York is 05:00 UTC. */
const EST_MIDNIGHT = Date.parse("2026-11-06T05:00:00.000Z");
/** 2026-07-06 is EDT (UTC-4). Midnight in New York is 04:00 UTC. */
const EDT_MIDNIGHT = Date.parse("2026-07-06T04:00:00.000Z");

describe("et calendar days", () => {
  it("splits EST and EDT midnights", () => {
    expect(etCalendarDay(EST_MIDNIGHT - 1)).toBe("2026-11-05");
    expect(etCalendarDay(EST_MIDNIGHT)).toBe("2026-11-06");
    expect(etCalendarDay(EDT_MIDNIGHT - 1)).toBe("2026-07-05");
    expect(etCalendarDay(EDT_MIDNIGHT)).toBe("2026-07-06");
  });

  it("counts one calendar day once", () => {
    expect(etCalendarDay(EST_MIDNIGHT)).toBe(etCalendarDay(EST_MIDNIGHT + 60 * 60 * 1000));
  });
});

describe("row status lines", () => {
  const now = Date.parse("2026-11-09T06:00:00Z");
  const quiet: LongRunningStatusInput = {
    needsYou: false,
    working: false,
    workingStartedAtMs: null,
    monitorCount: 0,
    backgroundTaskCount: 0,
    runningSubagentCount: 0,
    nextScheduledRunAtMs: null,
    nowMs: now,
    locale: "en-US",
    timeZone: "America/New_York",
  };
  it.each([
    [{ needsYou: true, working: true }, "Needs you"],
    [{ working: true, workingStartedAtMs: now - 18_000 }, "Working 18s"],
    [{ working: true, workingStartedAtMs: now - 12 * 60_000 }, "Working 12m"],
    [{ working: true, workingStartedAtMs: now - 134 * 60_000 }, "Working 2h 14m"],
    [{ working: true }, "Working 0s"],
    [{ working: true, workingStartedAtMs: now + 1000 }, "Working 0s"],
    [{ runningSubagentCount: 1, monitorCount: 2 }, "1 subagent running"],
    [{ runningSubagentCount: 3 }, "3 subagents running"],
    [{ monitorCount: 1, backgroundTaskCount: 2 }, "Waiting on 1 monitor"],
    [{ monitorCount: 2 }, "Waiting on 2 monitors"],
    [{ backgroundTaskCount: 1 }, "Waiting on 1 background task"],
    [{ backgroundTaskCount: 2 }, "Waiting on 2 background tasks"],
    [{ nextScheduledRunAtMs: Date.parse("2026-11-09T10:00:00Z") }, "Next run 5:00 AM"],
    [{ nextScheduledRunAtMs: Date.parse("2026-11-10T10:00:00Z") }, "Next run Tue 5:00 AM"],
    [{ nextScheduledRunAtMs: NaN }, null],
    [{}, null],
  ] as const)("formats %j as %s", (facts, expected) => {
    expect(longRunningStatusLine({ ...quiet, ...facts })).toBe(expected);
  });

  // A pin keeps the row out of Long-running, so the row says what it has out.
  it.each([
    [{ monitorCount: 2 }, "Waiting on 2 monitors"],
    [{ runningSubagentCount: 1 }, "1 subagent running"],
    [{ nextScheduledRunAtMs: Date.parse("2026-11-10T10:00:00Z") }, "Next run Tue 5:00 AM"],
    // The row's ordinary status already says these.
    [{ working: true, workingStartedAtMs: now - 18_000, monitorCount: 2 }, null],
    [{ needsYou: true, monitorCount: 2 }, null],
    [{}, null],
  ] as const)("a pinned chat with %j reads %s", (facts, expected) => {
    expect(pinnedWaitingLine({ ...quiet, ...facts })).toBe(expected);
  });

  it("normalizes shell counts and handles older servers and invalid timestamps", () => {
    const base = { runtimeStatus: "running", workingStartedAt: "invalid", nowMs: now };
    expect(longRunningFactsForShell(base)).toMatchObject({
      working: true,
      workingStartedAtMs: null,
      monitorCount: 0,
    });
    const tasks = [{ kind: "monitor" }, { kind: "command" }, { kind: "subagent" }, {}];
    expect(
      longRunningFactsForShell({
        ...base,
        pendingBackgroundTasks: tasks,
        pendingSubagentRequest: "approval",
      }),
    ).toMatchObject({
      needsYou: true,
      monitorCount: 1,
      backgroundTaskCount: 2,
      runningSubagentCount: 1,
    });
    expect(
      longRunningFactsForShell({
        ...base,
        pendingBackgroundTasks: tasks,
        longRunningWork: { monitorCount: 0, backgroundTaskCount: 0, runningSubagentCount: 0 },
      }),
    ).toMatchObject({ monitorCount: 0, backgroundTaskCount: 0, runningSubagentCount: 0 });
  });
});

describe("subagents confirmation", () => {
  it("confirms only when turning the switch off", () => {
    expect(subagentsToggleNeedsConfirm(false)).toBe(true);
    expect(subagentsToggleNeedsConfirm(true)).toBe(false);
  });

  it("names the model and what stays available", () => {
    const copy = subagentsOffConfirmation("Claude Opus");
    expect(copy.question).toBe("Turn off subagents for this chat?");
    expect(copy.detail).toBe(
      "Claude Opus will do all the work itself: no subagents on other models, no council, no SSHCode delegation.",
    );
    expect(copy.secondary).toContain("create_threads");
    expect(copy.secondary).toContain("Claude Code's Agent tool");
    expect(copy.secondary).toContain("page reader");
    expect(copy.secondary).toContain("Codex's own agents");
  });

  it("names the orchestration tools a chat hides", () => {
    expect(SUBAGENT_ORCHESTRATION_TOOLS).toEqual([
      "delegate_task",
      "council",
      "task_status",
      "task_cancel",
      "workflow",
    ]);
    expect(isSubagentOrchestrationTool("delegate_task")).toBe(true);
    expect(isSubagentOrchestrationTool("workflow")).toBe(true);
    expect(isSubagentOrchestrationTool("create_threads")).toBe(false);
    expect(isSubagentOrchestrationTool("ask_user")).toBe(false);
  });
});

describe("subagent waiting on its own background work", () => {
  const work = (monitorCount: number, backgroundTaskCount = 0, runningSubagentCount = 0) => ({
    monitorCount,
    backgroundTaskCount,
    runningSubagentCount,
  });

  it("names what a subagent left running once its turn has ended", () => {
    expect(subagentBackgroundWaitLabel({ runtimeStatus: "idle", longRunningWork: work(2) })).toBe(
      "Waiting on 2 monitors",
    );
    expect(subagentBackgroundWaitLabel({ runtimeStatus: null, longRunningWork: work(0, 1) })).toBe(
      "Waiting on 1 background task",
    );
    expect(
      subagentBackgroundWaitLabel({ runtimeStatus: "idle", longRunningWork: work(3, 2, 1) }),
    ).toBe("Waiting on 1 subagent");
  });

  it("keeps the ordinary status while the subagent works or has nothing out", () => {
    expect(
      subagentBackgroundWaitLabel({ runtimeStatus: "running", longRunningWork: work(2) }),
    ).toBeNull();
    expect(
      subagentBackgroundWaitLabel({ runtimeStatus: "idle", longRunningWork: work(0) }),
    ).toBeNull();
    expect(subagentBackgroundWaitLabel({ runtimeStatus: "idle" })).toBeNull();
  });
});

describe("quiet turn label", () => {
  const last = Date.parse("2026-11-14T05:00:00.000Z");

  it("stays silent until the turn has shown nothing for the whole window", () => {
    expect(quietTurnLabel(last, last)).toBeNull();
    expect(quietTurnLabel(last, last + QUIET_TURN_AFTER_MS - 1)).toBeNull();
    expect(msUntilQuietTurn(last, last + QUIET_TURN_AFTER_MS - 1)).toBe(1);
  });

  it("then says how long it has been quiet", () => {
    expect(quietTurnLabel(last, last + QUIET_TURN_AFTER_MS)).toBe("Quiet 15m");
    expect(quietTurnLabel(last, last + 82 * 60_000)).toBe("Quiet 1h 22m");
  });

  it("says nothing when the last activity is unknown", () => {
    expect(quietTurnLabel(null, last)).toBeNull();
    expect(quietTurnLabel(Number.NaN, last)).toBeNull();
  });
});
