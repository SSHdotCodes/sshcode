// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Small isolated SQLite fixtures verify the standalone read boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { readLiveReport, renderLiveMarkdown, type LiveReportOptions } from "./live.ts";

const NOW = new Date("2026-11-08T12:00:00.000Z");
const START = "2026-11-07T12:00:00.000Z";
const END = "2026-11-07T13:00:00.000Z";
const FROM = "2026-11-01T12:00:00.000Z";
const SECRET = "PRIVATE_BODY_DO_NOT_EMIT";
let dir: string;
let path: string;
let db: NodeSqlite.DatabaseSync;

const schema = `
CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY,stream_id TEXT,occurred_at TEXT,application_event_version INTEGER,aggregate_kind TEXT);
CREATE INDEX idx_orchestration_events_application_sequence ON orchestration_events(application_event_version,sequence);
CREATE TABLE orchestration_v2_projection_subagents(subagent_id TEXT PRIMARY KEY,thread_id TEXT,provider TEXT,provider_thread_id TEXT,child_thread_id TEXT,origin TEXT,status TEXT,started_at TEXT,completed_at TEXT,payload_json TEXT);
CREATE INDEX orchestration_v2_projection_subagents_thread_idx ON orchestration_v2_projection_subagents(thread_id,started_at,subagent_id);
CREATE TABLE orchestration_v2_projection_runs(run_id TEXT PRIMARY KEY,thread_id TEXT,provider TEXT,provider_thread_id TEXT,status TEXT,requested_at TEXT,completed_at TEXT,ordinal INTEGER,payload_json TEXT);
CREATE UNIQUE INDEX orchestration_v2_projection_runs_thread_ordinal_idx ON orchestration_v2_projection_runs(thread_id,ordinal);
CREATE TABLE orchestration_v2_projection_run_attempts(attempt_id TEXT PRIMARY KEY,run_id TEXT,attempt_ordinal INTEGER,provider_thread_id TEXT,payload_json TEXT);
CREATE UNIQUE INDEX orchestration_v2_projection_run_attempts_run_ordinal_idx ON orchestration_v2_projection_run_attempts(run_id,attempt_ordinal);
CREATE TABLE orchestration_v2_projection_provider_turns(provider_turn_id TEXT PRIMARY KEY,provider_thread_id TEXT,run_attempt_id TEXT,ordinal INTEGER,started_at TEXT,completed_at TEXT,status TEXT,payload_json TEXT);
CREATE UNIQUE INDEX orchestration_v2_projection_provider_turns_thread_ordinal_idx ON orchestration_v2_projection_provider_turns(provider_thread_id,ordinal);
CREATE TABLE orchestration_v2_projection_turn_items(turn_item_id TEXT PRIMARY KEY,run_id TEXT,provider_turn_id TEXT,ordinal INTEGER,type TEXT,status TEXT,updated_at TEXT,payload_json TEXT);
CREATE INDEX orchestration_v2_projection_turn_items_run_ordinal_idx ON orchestration_v2_projection_turn_items(run_id,ordinal);
CREATE INDEX orchestration_v2_projection_turn_items_provider_turn_idx ON orchestration_v2_projection_turn_items(provider_turn_id);
`;

beforeEach(() => {
  dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "agent-quality-live-"));
  path = NodePath.join(dir, "statev2.sqlite");
  db = new NodeSqlite.DatabaseSync(path);
  db.exec(schema);
});
afterEach(() => {
  if (db.isOpen) db.close();
  NodeFS.rmSync(dir, { recursive: true, force: true });
});

function event(thread = "parent", at = END, sequence?: number) {
  db.prepare("INSERT INTO orchestration_events VALUES(?,?,?,?,?)").run(
    sequence ?? null,
    thread,
    at,
    2,
    "thread",
  );
}
function task(
  id: string,
  options: {
    start?: string;
    end?: string;
    status?: string;
    parent?: string;
    native?: boolean;
    payload?: unknown;
  } = {},
) {
  const start = options.start ?? START;
  const end = options.end ?? END;
  const parent = options.parent ?? "parent";
  event(parent, end);
  db.prepare("INSERT INTO orchestration_v2_projection_subagents VALUES(?,?,?,?,?,?,?,?,?,?)").run(
    id,
    parent,
    "codex",
    `pt-${id}`,
    options.native ? null : `child-${id}`,
    options.native ? "provider_native" : "app_owned",
    options.status ?? "completed",
    start,
    end,
    JSON.stringify(
      options.payload ?? { model: "test-model", prompt: SECRET, result: `done. ${SECRET}` },
    ),
  );
}
function run(
  id: string,
  ordinal = 1,
  options: {
    model?: string;
    tokens?: number | null;
    usageStatus?: string;
    text?: string;
    taskId?: string;
    runId?: string;
  } = {},
) {
  const runId = options.runId ?? `run-${id}-${ordinal}`;
  const attempt = `attempt-${runId}`;
  const turn = `turn-${runId}`;
  db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES(?,?,?,?,?,?,?,?,?)").run(
    runId,
    `child-${id}`,
    "codex",
    `pt-${id}`,
    "completed",
    START,
    END,
    ordinal,
    JSON.stringify({
      delegatedTaskId: options.taskId ?? id,
      modelSelection: { model: options.model ?? "test-model" },
    }),
  );
  db.prepare("INSERT INTO orchestration_v2_projection_run_attempts VALUES(?,?,?,?,?)").run(
    attempt,
    runId,
    1,
    `pt-${id}`,
    "{}",
  );
  db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES(?,?,?,?,?,?,?,?)").run(
    turn,
    `pt-${id}`,
    attempt,
    ordinal,
    START,
    END,
    "completed",
    JSON.stringify(
      options.tokens === null
        ? { tokenUsage: { usedTokens: 99 } }
        : {
            turnTokenUsage: {
              usageStatus: options.usageStatus ?? "complete",
              usageScope: "main_agent",
              hasSubagents: false,
              inputTokens: options.tokens ?? 10,
              outputTokens: 0,
            },
          },
    ),
  );
  item(
    runId,
    1,
    "assistant_message",
    "completed",
    { text: options.text ?? `Done. ${SECRET}`, streaming: false },
    turn,
  );
  return { runId, turn };
}
function item(
  runId: string,
  ordinal: number,
  type: string,
  status: string,
  payload: unknown,
  turn?: string,
) {
  db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES(?,?,?,?,?,?,?,?)").run(
    `item-${runId}-${ordinal}`,
    runId,
    turn ?? null,
    ordinal,
    type,
    status,
    END,
    JSON.stringify(payload),
  );
}
const read = (options: LiveReportOptions = {}) =>
  readLiveReport({ dbPath: path, now: NOW, ...options });

describe("live delegated-task metrics", () => {
  it("computes median/p90, separates models, and reports daily completion trends without bodies", () => {
    for (let i = 1; i <= 10; i++) {
      task(`t${i}`);
      run(`t${i}`, 1, { tokens: i * 10 });
    }
    task("missing");
    run("missing", 1, { tokens: null, model: "other" });
    const report = read();
    const group = report.groups.find((g) => g.model === "test-model")!;
    expect(group.tokens).toEqual({ known: 10, unknown: 0, median: 55, p90: 90 });
    expect(group.turns).toEqual({ known: 10, unknown: 0, median: 1, p90: 1 });
    expect(group.fixRoundsHeuristic.median).toBe(0);
    expect(report.groups.find((g) => g.model === "other")!.tokens).toEqual({
      known: 0,
      unknown: 1,
      median: null,
      p90: null,
    });
    expect(report.daily.map((d) => d.date)).toEqual(["2026-11-07"]);
    expect(report.daily[0]!.groups).toEqual(report.groups);
    expect(report.window).toEqual({ from: FROM, to: NOW.toISOString(), days: 7 });
    expect(report.serverVersion.available).toBe(false);
    expect(JSON.stringify(report)).not.toContain(SECRET);
    const markdown = renderLiveMarkdown(report);
    expect(markdown).not.toContain(SECRET);
    expect(markdown).toContain("55 / 90 (n=10, unknown=0)");
    expect(markdown).toContain("unavailable");
  });

  it("uses only explicitly attributed runs and the last final paragraph for heuristic denominators", () => {
    task("t");
    run("t", 1, { text: "I can investigate.\n\nDone." });
    const last = run("t", 2, { text: "Done.\n\nIf you'd like, I can add more tests." });
    run("t", 3, { taskId: "another-task", text: "Unrelated." });
    item(last.runId, 8, "assistant_message", "running", {
      text: "still streaming",
      streaming: true,
    });
    item(last.runId, 9, "dynamic_tool", "failed", { toolName: "mcp__demo__lookup", input: SECRET });
    item(last.runId, 10, "dynamic_tool", "completed", {
      toolName: "mcp__demo__lookup",
      output: { isError: true, text: SECRET },
    });
    item(last.runId, 11, "dynamic_tool", "completed", {
      toolName: "mcp__demo__lookup",
      output: { isError: false },
    });
    item(last.runId, 12, "dynamic_tool", "cancelled", { toolName: "mcp__demo__lookup" });
    item(last.runId, 13, "dynamic_tool", "completed", { toolName: "shell" });
    const g = read().groups[0]!;
    expect(g.tokens.median).toBe(20);
    expect(g.turns.median).toBe(2);
    expect(g.fixRoundsHeuristic.median).toBe(1);
    expect(g.finalProseOfferHeuristic).toEqual({ matches: 1, denominator: 1, unknown: 0, rate: 1 });
    expect(g.mcpErrors).toEqual([
      { tool: "mcp__demo__lookup", errors: 2, denominator: 3, unknown: 1, rate: 2 / 3 },
    ]);
  });

  it("keeps partial, absent, malformed, and overflow usage unknown while retaining genuine zero", () => {
    for (const id of ["zero", "partial", "absent", "malformed", "overflow"]) task(id);
    run("zero", 1, { tokens: 0 });
    run("partial", 1, { usageStatus: "partial" });
    run("absent", 1, { tokens: null });
    run("malformed");
    run("overflow", 1, { tokens: Number.MAX_SAFE_INTEGER });
    db.prepare(
      "UPDATE orchestration_v2_projection_provider_turns SET payload_json=? WHERE provider_turn_id=?",
    ).run("not-json", "turn-run-malformed-1");
    db.prepare(
      "UPDATE orchestration_v2_projection_provider_turns SET payload_json=? WHERE provider_turn_id=?",
    ).run(
      JSON.stringify({
        turnTokenUsage: {
          usageStatus: "complete",
          usageScope: "main_agent",
          inputTokens: Number.MAX_SAFE_INTEGER,
          outputTokens: 1,
        },
      }),
      "turn-run-overflow-1",
    );
    expect(read().groups[0]!.tokens).toEqual({ known: 1, unknown: 4, median: 0, p90: 0 });
  });

  it("marks mixed-model tasks and missing attribution honestly", () => {
    task("mixed");
    run("mixed", 1, { model: "a" });
    run("mixed", 2, { model: "b" });
    task("unattributed");
    run("unattributed", 1, { taskId: "not-this-task" });
    const report = read();
    expect(report.groups.find((g) => g.model === "mixed")!.turns.median).toBe(2);
    const unknown = report.groups.find((g) => g.model === "test-model")!;
    expect(unknown.tokens.unknown).toBe(1);
    expect(unknown.turns.unknown).toBe(1);
    expect(unknown.fixRoundsHeuristic.unknown).toBe(1);
    expect(unknown.finalProseOfferHeuristic.unknown).toBe(1);
  });

  it("handles provider-native tasks without inventing run counts", () => {
    task("native", {
      native: true,
      payload: { model: "native-model", result: "Done.\n\nWant me to continue?" },
    });
    const native = run("native");
    db.prepare("DELETE FROM orchestration_v2_projection_runs WHERE run_id=?").run(native.runId);
    db.prepare("DELETE FROM orchestration_v2_projection_run_attempts WHERE run_id=?").run(
      native.runId,
    );
    const g = read().groups[0]!;
    expect(g.tokens.median).toBe(10);
    expect(g.turns.median).toBe(1);
    expect(g.fixRoundsHeuristic.unknown).toBe(1);
    expect(g.finalProseOfferHeuristic.rate).toBe(1);
  });
});

describe("read and work boundaries", () => {
  it("uses a half-open seven-day window and excludes failed, in-flight and cross-window tasks", () => {
    task("included", { start: FROM });
    run("included");
    task("before", { start: "2026-11-01T11:59:59.999Z" });
    task("at-end", { end: NOW.toISOString() });
    task("failed", { status: "failed" });
    task("running", { status: "running" });
    task("future", { start: "2026-11-09T12:00:00.000Z", end: "2026-11-09T13:00:00.000Z" });
    expect(read().coverage.completedTasks).toBe(1);
  });

  it("does not mutate the database or create sidecars and never creates a missing database", () => {
    task("t");
    run("t");
    db.close();
    NodeFS.chmodSync(path, 0o400);
    const before = NodeFS.readFileSync(path);
    const files = NodeFS.readdirSync(dir);
    expect(read().coverage.completedTasks).toBe(1);
    expect(NodeFS.readFileSync(path)).toEqual(before);
    expect(NodeFS.readdirSync(dir)).toEqual(files);
    const missing = NodePath.join(dir, "missing.sqlite");
    expect(() => read({ dbPath: missing })).toThrow();
    expect(NodeFS.existsSync(missing)).toBe(false);
  });

  it("ignores uncheckpointed WAL without changing either sidecar", () => {
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE);",
    );
    task("only-in-wal");
    const before = new Map(
      NodeFS.readdirSync(dir).map((name) => [name, NodeFS.readFileSync(NodePath.join(dir, name))]),
    );
    const report = read();
    expect(report.coverage.completedTasks).toBe(0);
    expect(report.source).toContain("WAL excluded");
    expect(NodeFS.readdirSync(dir).sort()).toEqual([...before.keys()].sort());
    for (const [name, bytes] of before)
      expect(NodeFS.readFileSync(NodePath.join(dir, name))).toEqual(bytes);
  });

  it("caps the event sequence span and number of discovered threads", () => {
    task("old", { parent: "old-parent" });
    task("new", { parent: "new-parent" });
    const report = read({ maxEvents: 1, maxThreads: 1 });
    expect(report.coverage.events).toBe(1);
    expect(report.coverage.threads).toBe(1);
    expect(report.coverage.completedTasks).toBe(1);
    expect(report.coverage.eventSequenceTo - report.coverage.eventSequenceFrom).toBe(0);
    expect(report.coverage.capped).toBe(true);
  });

  it("caps task, partition, and total query work and avoids partial task totals", () => {
    task("t");
    run("t", 1);
    run("t", 2);
    const capped = read({ maxRowsPerQuery: 1, maxTasksPerThread: 1 });
    expect(capped.coverage.capped).toBe(true);
    expect(capped.groups[0]!.tokens.unknown).toBe(1);
    expect(capped.groups[0]!.turns.unknown).toBe(1);
    expect(capped.groups[0]!.fixRoundsHeuristic.unknown).toBe(1);
    expect(capped.groups[0]!.finalProseOfferHeuristic.unknown).toBe(1);
    const limited = read({ maxQueries: 3 });
    expect(limited.coverage.queries).toBe(3);
    expect(limited.groups[0]!.tokens.unknown).toBe(1);
  });

  it("caps UTF-8 payload bytes before parsing, and enforces the total parse budget", () => {
    task("t", { payload: { model: "test-model", prompt: "😺".repeat(100) } });
    run("t");
    const rowCapped = read({ maxPayloadBytes: 300 });
    expect(rowCapped.coverage.skippedPayloads).toBeGreaterThan(0);
    expect(rowCapped.coverage.capped).toBe(true);
    const totalCapped = read({ maxTotalPayloadBytes: 1 });
    expect(totalCapped.coverage.parsedPayloadBytes).toBe(0);
    expect(totalCapped.groups[0]!.tokens.unknown).toBe(1);
    expect(totalCapped.groups[0]!.finalProseOfferHeuristic.unknown).toBe(1);
  });

  it("requires existing indexes, rejects sort/scan plans, and records every data query plan", () => {
    task("t");
    run("t");
    const report = read();
    expect(report.queryPlans.map((q) => q.query)).toEqual([
      "event-high-water",
      "event-tail",
      "tasks-by-thread-time",
      "child-runs",
      "run-attempts",
      "provider-turns",
      "run-items",
    ]);
    for (const plan of report.queryPlans)
      expect(plan.details.some((d) => d.startsWith("SEARCH "))).toBe(true);
    db.exec("DROP INDEX orchestration_v2_projection_subagents_thread_idx");
    expect(() => read()).toThrow();
    db.exec(
      "CREATE INDEX orchestration_v2_projection_subagents_thread_idx ON orchestration_v2_projection_subagents(thread_id)",
    );
    expect(() => read()).toThrow("Unsafe query plan");
  });

  it.each([0, -1, 32, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid days %s before opening",
    (days) => {
      expect(() => read({ days })).toThrow("Expected an integer");
    },
  );

  it("rejects excessive budgets and invalid dates", () => {
    expect(() => read({ maxEvents: 200_001 })).toThrow();
    expect(() => read({ maxTotalPayloadBytes: 67_108_865 })).toThrow();
    expect(() => read({ now: new Date("invalid") })).toThrow("Invalid report time");
  });
});
