// @effect-diagnostics globalDate:off - Fixtures use UTC instants to verify the reporting window.
import assert from "node:assert/strict";
import { describe, it } from "vite-plus/test";
import {
  buildReport,
  isReviewTitle,
  median,
  mostFrequentModel,
  newYorkDay,
  parsePayload,
  parseTime,
  roundTo,
  unionMinutes,
  type RunRow,
  type ThreadRow,
} from "./report.ts";

const UNTIL = Date.parse("2026-11-10T12:00:00.000Z");
const opts = { until: UNTIL, days: 14, top: 15 };

function thread(id: string, payload: unknown = {}, extra: Partial<ThreadRow> = {}): ThreadRow {
  return {
    thread_id: id,
    title: `Title ${id}`,
    created_at: "2026-11-05T12:00:00.000Z",
    payload_json: typeof payload === "string" ? payload : JSON.stringify(payload),
    ...extra,
  };
}

let seq = 0;
function run(
  threadId: string,
  {
    model = "m",
    minutes = 10,
    start = "2026-11-05T12:00:00.000Z",
    status = "completed",
    requested,
    id = "",
  }: {
    model?: string;
    minutes?: number;
    start?: string;
    status?: string;
    requested?: string;
    id?: string;
  } = {},
): RunRow {
  const startMs = Date.parse(start);
  return {
    run_id: id || `run-${++seq}`,
    thread_id: threadId,
    status,
    requested_at: requested ?? start,
    completed_at: new Date(startMs + minutes * 60_000).toISOString(),
    payload_json: JSON.stringify({ startedAt: start, modelSelection: { model } }),
  };
}

const sub = (root?: string) => ({
  lineage: { relationshipToParent: "subagent", rootThreadId: root },
});

describe("parsing helpers", () => {
  it("treats invalid, non-object or missing payloads as {}", () => {
    assert.deepEqual(parsePayload("{not json"), {});
    assert.deepEqual(parsePayload("[1,2]"), {});
    assert.deepEqual(parsePayload("42"), {});
    assert.deepEqual(parsePayload("null"), {});
    assert.deepEqual(parsePayload(null), {});
    assert.deepEqual(parsePayload('{"a":1}'), { a: 1 });
  });

  it("parses ISO times as instants and rejects junk", () => {
    assert.equal(parseTime("2026-11-10T12:00:00.000Z"), UNTIL);
    assert.equal(parseTime("2026-11-10T07:00:00-05:00"), UNTIL);
    assert.equal(parseTime("2026-11-10T12:00:00"), UNTIL);
    assert.equal(parseTime("2026-11-10T12:00:00.123456Z"), UNTIL + 123);
    assert.equal(parseTime("nope"), null);
    assert.equal(parseTime("2026-02-30T00:00:00Z"), null);
    assert.equal(parseTime(""), null);
    assert.equal(parseTime(null), null);
    assert.equal(parseTime(12), null);
  });

  it("rounds like Python, half to even on exact ties", () => {
    assert.equal(roundTo(0.25, 1), 0.2);
    assert.equal(roundTo(0.35, 1), 0.3); // 0.35 is slightly below in binary
    assert.equal(roundTo(0.75, 1), 0.8);
    assert.equal(roundTo(1.125, 2), 1.12);
    assert.equal(roundTo(2.675, 2), 2.67);
    assert.equal(roundTo(6.66, 1), 6.7);
    assert.equal(roundTo(0, 1), 0);
  });

  it("detects reviews by the three title rules", () => {
    assert.ok(isReviewTitle("Review: cache change"));
    assert.ok(isReviewTitle("Independent review of the export"));
    assert.ok(isReviewTitle("Security AUDIT of login"));
    assert.ok(isReviewTitle(`${"x".repeat(33)} review`));
    assert.ok(!isReviewTitle(`${"x".repeat(34)} review`));
    assert.ok(!isReviewTitle(`${"x".repeat(30)}audit`));
    assert.ok(isReviewTitle(`${"x".repeat(25)}audit`));
    assert.ok(!isReviewTitle("Preview build"));
  });

  it("computes medians and interval unions", () => {
    assert.equal(median([5, 1, 3]), 3);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    const t = (m: number) => m * 60_000;
    assert.equal(unionMinutes([]), 0);
    assert.equal(
      unionMinutes([
        [t(0), t(10)],
        [t(5), t(15)],
        [t(20), t(25)],
        [t(21), t(22)],
      ]),
      20,
    );
  });

  it("buckets days in America/New_York across daylight saving", () => {
    assert.equal(newYorkDay(Date.parse("2026-11-10T04:59:59Z")), "2026-11-09");
    assert.equal(newYorkDay(Date.parse("2026-11-10T05:00:00Z")), "2026-11-10");
    assert.equal(newYorkDay(Date.parse("2026-10-30T03:59:59Z")), "2026-10-29");
    assert.equal(newYorkDay(Date.parse("2026-10-30T04:00:00Z")), "2026-10-30");
  });
});

describe("mostFrequentModel", () => {
  const r = (model: string, requestedAt: number, runId: string) => ({
    runId,
    requestedAt,
    model,
    status: null,
    minutes: 0,
    interval: null,
  });
  it("picks the most common model", () => {
    assert.equal(mostFrequentModel([r("a", 1, "1"), r("b", 2, "2"), r("a", 0, "3")]), "a");
  });
  it("breaks ties by the latest run, then run_id", () => {
    assert.equal(mostFrequentModel([r("a", 5, "1"), r("b", 2, "2")]), "a");
    assert.equal(mostFrequentModel([r("a", 5, "1"), r("b", 5, "2")]), "b");
    assert.equal(
      mostFrequentModel([
        r("a", 5, "1"),
        r("b", 9, "2"),
        r("c", 9, "3"),
        r("c", 1, "4"),
        r("b", 1, "5"),
      ]),
      "c",
    );
  });
});

describe("buildReport", () => {
  it("applies the window inclusively and ignores unparseable requested_at", () => {
    const runs = [
      run("lead", { start: "2026-10-27T12:00:00.000Z" }),
      run("lead", { start: "2026-11-10T12:00:00.000Z", minutes: 0 }),
      run("lead", { start: "2026-10-27T11:59:59.999Z" }),
      run("lead", { start: "2026-11-10T12:00:00.001Z" }),
      { ...run("lead"), requested_at: "garbage" },
      { ...run("lead"), requested_at: null },
    ];
    const report = buildReport([thread("lead")], runs, opts);
    assert.equal(report.chats[0]?.turns, 2);
    assert.deepEqual(report.window, {
      days: 14,
      since: "2026-10-27T12:00:00.000Z",
      until: "2026-11-10T12:00:00.000Z",
    });
  });

  it("classifies subagents by lineage or id prefix, and missing thread rows by prefix", () => {
    const threads = [
      thread("lead"),
      thread("child", sub("lead")),
      thread("thread:delegated-task:x", "{bad json"),
      thread("other", { lineage: { relationshipToParent: "fork" } }),
    ];
    const runs = [
      run("lead"),
      run("child"),
      run("thread:delegated-task:x"),
      run("other"),
      run("thread:delegated-task:ghost"),
      run("ghost-lead"),
    ];
    const report = buildReport(threads, runs, opts);
    assert.equal(report.totals.leadChats, 3);
    assert.equal(report.totals.subagentTasks, 3);
    const ghost = report.chats.find((c) => c.threadId === "ghost-lead");
    assert.equal(ghost?.title, "");
    // Ghost subagent has no creation time, so days only count the two known tasks.
    assert.equal(
      report.days.reduce((n, d) => n + d.subagentTasks, 0),
      2,
    );
  });

  it("resolves the root from rootThreadId, then parentThreadId", () => {
    const threads = [
      thread("a"),
      thread("b"),
      thread("t1", {
        lineage: { relationshipToParent: "subagent", rootThreadId: "a", parentThreadId: "b" },
      }),
      thread("t2", { lineage: { relationshipToParent: "subagent", parentThreadId: "b" } }),
      thread("t3", { lineage: { relationshipToParent: "subagent" } }),
    ];
    const runs = [run("a"), run("b"), run("t1"), run("t2"), run("t3")];
    const report = buildReport(threads, runs, opts);
    const byId = new Map(report.chats.map((c) => [c.threadId, c]));
    assert.equal(byId.get("a")?.subagentTasks, 1);
    assert.equal(byId.get("b")?.subagentTasks, 1);
    assert.equal(report.totals.leadChatsWithSubagents, 2);
    assert.equal(report.totals.subagentTasks, 3);
  });

  it("computes run minutes only from valid, non-negative startedAt..completed_at", () => {
    const good = run("lead", { minutes: 30 });
    const negative = { ...run("lead"), completed_at: "2026-11-05T11:00:00.000Z" };
    const noStart = {
      ...run("lead"),
      payload_json: JSON.stringify({ modelSelection: { model: "m" } }),
    };
    const noEnd = { ...run("lead"), completed_at: null };
    const report = buildReport([thread("lead")], [good, negative, noStart, noEnd], opts);
    assert.equal(report.totals.leadHours, 0.5);
    assert.equal(report.chats[0]?.turns, 4);
  });

  it("groups lead runs by model with status groups and unknown models", () => {
    const runs = [
      run("l1", { model: "x", status: "completed" }),
      run("l1", { model: "x", status: "failed" }),
      run("l2", { model: "x", status: "cancelled" }),
      run("l2", { model: "x", status: "interrupted" }),
      run("l2", { model: "x", status: "running" }),
      { ...run("l1"), payload_json: JSON.stringify({ modelSelection: { model: "" } }) },
      { ...run("l1"), payload_json: "not json" },
    ];
    const report = buildReport([thread("l1"), thread("l2")], runs, opts);
    assert.deepEqual(report.leadModels[0], {
      model: "x",
      runs: 5,
      chats: 2,
      completed: 1,
      failed: 1,
      stopped: 2,
      hours: 0.8,
    });
    assert.equal(report.leadModels[1]?.model, "unknown");
    assert.equal(report.leadModels[1]?.runs, 2);
  });

  it("sorts lead models by runs then name, and chats by unrounded hours then id, limited to top", () => {
    const runs = [
      run("b", { model: "zeta", minutes: 61 }),
      run("a", { model: "alpha", minutes: 59 }),
      run("c", { model: "beta", minutes: 61 }),
    ];
    const report = buildReport([thread("a"), thread("b"), thread("c")], runs, { ...opts, top: 2 });
    assert.deepEqual(
      report.leadModels.map((m) => m.model),
      ["alpha", "beta", "zeta"],
    );
    assert.deepEqual(
      report.chats.map((c) => c.threadId),
      ["b", "c"],
    );
    assert.equal(report.totals.leadChats, 3);
  });

  it("summarises subagent models: median, buckets, follow-ups and hours", () => {
    const threads = [
      thread("lead"),
      ...["t1", "t2", "t3", "t4"].map((id) => thread(id, sub("lead"))),
    ];
    const runs = [
      run("lead"),
      run("t1", { minutes: 2.5, model: "w" }),
      run("t2", { minutes: 3, model: "w" }),
      run("t2", { minutes: 17, model: "w" }),
      run("t3", { minutes: 60, model: "w" }),
      run("t4", { minutes: 59.9, model: "w" }),
      run("t4", { minutes: 1, model: "other" }),
      run("t4", { minutes: 1, model: "other" }),
    ];
    const report = buildReport(threads, runs, opts);
    // t4's model is "other" (2 runs vs 1).
    assert.deepEqual(report.subagentModels, [
      {
        model: "w",
        tasks: 3,
        medianMinutes: 20,
        under3: 1,
        from3to20: 0,
        from20to60: 1,
        over60: 1,
        followUpsPerTask: 0.3,
        hours: 1.4,
      },
      {
        model: "other",
        tasks: 1,
        medianMinutes: 61.9,
        under3: 0,
        from3to20: 0,
        from20to60: 0,
        over60: 1,
        followUpsPerTask: 2,
        hours: 1,
      },
    ]);
  });

  it("computes concurrency from task run intervals, 0 when there are none", () => {
    const threads = [
      thread("lead"),
      thread("idle"),
      thread("t1", sub("lead")),
      thread("t2", sub("lead")),
      thread("t3", sub("idle")),
    ];
    const runs = [
      run("lead"),
      run("idle"),
      run("t1", { start: "2026-11-05T12:00:00.000Z", minutes: 30 }),
      run("t2", { start: "2026-11-05T12:15:00.000Z", minutes: 30 }),
      run("t3", { minutes: 0 }),
    ];
    const report = buildReport(threads, runs, opts);
    const byId = new Map(report.chats.map((c) => [c.threadId, c]));
    assert.equal(byId.get("lead")?.concurrency, 1.33); // 60 / 45
    assert.equal(byId.get("idle")?.concurrency, 0);
    assert.equal(byId.get("idle")?.subagentTasks, 1);
  });

  it("counts tasks by New York creation day, payload createdAt first, with reviews", () => {
    const threads = [
      thread("t1", { ...sub(), createdAt: "2026-11-09T03:00:00.000Z" }, { title: "Review: x" }),
      thread("t2", sub(), { created_at: "2026-11-09T06:00:00.000Z", title: "Fix bug" }),
      thread("t3", "{bad", {
        thread_id: "thread:delegated-task:t3",
        created_at: "2026-11-09T07:00:00.000Z",
      }),
      thread("t4", sub(), { created_at: null }),
    ];
    const runs = [run("t1"), run("t2"), run("thread:delegated-task:t3"), run("t4")];
    const report = buildReport(threads, runs, opts);
    assert.deepEqual(report.days, [
      { day: "2026-11-08", subagentTasks: 1, reviews: 1 },
      { day: "2026-11-09", subagentTasks: 2, reviews: 0 },
    ]);
    assert.equal(report.totals.subagentTasks, 4);
  });

  it("counts deleted and archived threads, and ignores threads with no runs in the window", () => {
    const threads = [
      thread("gone", {}, { title: "Gone" }),
      thread("quiet"),
      thread("t-old", sub("gone")),
    ];
    const runs = [run("gone"), run("t-old", { start: "2026-01-01T00:00:00.000Z" })];
    const report = buildReport(threads, runs, opts);
    assert.equal(report.totals.leadChats, 1);
    assert.equal(report.totals.subagentTasks, 0);
    assert.equal(report.totals.leadChatsWithSubagents, 0);
  });
});
