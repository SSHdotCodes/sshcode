// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Isolated synchronous Node and SQLite CLI fixtures.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, it } from "vite-plus/test";
import { parseArgs, UsageError } from "./cli.ts";
import { readRows } from "./db.ts";
import { renderJson, renderText } from "./render.ts";
import { buildReport } from "./report.ts";

const CLI = join(import.meta.dirname, "cli.ts");
const SAMPLE_DIR = "/private/tmp/fusion-test";
const cli = (...args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

const tmp = mkdtempSync(join(tmpdir(), "usage-report-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function createDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE orchestration_v2_projection_threads (
      thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, default_provider TEXT, runtime_mode TEXT,
      interaction_mode TEXT, active_provider_thread_id TEXT, created_at TEXT, updated_at TEXT,
      archived_at TEXT, deleted_at TEXT, payload_json TEXT, provider_instance_id TEXT);
    CREATE TABLE orchestration_v2_projection_runs (
      run_id TEXT PRIMARY KEY, thread_id TEXT, ordinal INTEGER, provider TEXT, provider_thread_id TEXT,
      status TEXT, requested_at TEXT, completed_at TEXT, payload_json TEXT, provider_instance_id TEXT);`);
  return db;
}

describe("parseArgs", () => {
  it("applies defaults and reads flags in both forms", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    assert.deepEqual(parseArgs(["--db", "x.sqlite"], now), {
      db: "x.sqlite",
      days: 14,
      until: now,
      top: 15,
      json: false,
      help: false,
    });
    const o = parseArgs([
      "--db=x",
      "--days=3",
      "--top",
      "0",
      "--until",
      "2026-11-10T12:00:00Z",
      "--json",
    ]);
    assert.equal(o.days, 3);
    assert.equal(o.top, 0);
    assert.equal(o.until, Date.parse("2026-11-10T12:00:00Z"));
    assert.equal(o.json, true);
  });

  it("rejects bad arguments", () => {
    for (const argv of [
      [],
      ["--db"],
      ["--db", "x", "--days", "-1"],
      ["--db", "x", "--top", "1.5"],
      ["--db", "x", "--until", "soon"],
      ["--db", "x", "extra"],
    ]) {
      assert.throws(() => parseArgs(argv), UsageError, argv.join(" "));
    }
  });
});

describe("cli", () => {
  it("exits 2 with one line on stderr for bad arguments and unreadable databases", () => {
    for (const args of [
      [],
      ["--days", "x", "--db", "a"],
      ["--db", join(tmp, "missing.sqlite")],
      ["--db", CLI],
    ]) {
      const result = cli(...args);
      assert.equal(result.status, 2, args.join(" "));
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /^usage-report: [^\n]+\n$/);
    }
  });

  it("exits 2 when the tables are missing", () => {
    const path = join(tmp, "empty.sqlite");
    new DatabaseSync(path).close();
    assert.equal(cli("--db", path).status, 2);
  });

  it(
    "matches the expected sample output exactly",
    { skip: !existsSync(join(SAMPLE_DIR, "sample.sqlite")) },
    () => {
      const result = cli(
        "--db",
        join(SAMPLE_DIR, "sample.sqlite"),
        "--until",
        "2026-11-10T12:00:00.000Z",
        "--json",
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, readFileSync(join(SAMPLE_DIR, "sample-expected.json"), "utf8"));
    },
  );

  it("handles 200,000 runs in under 3 seconds", () => {
    const path = join(tmp, "big.sqlite");
    const db = createDb(path);
    db.exec("BEGIN");
    const insertThread = db.prepare(
      "INSERT INTO orchestration_v2_projection_threads (thread_id, title, created_at, payload_json) VALUES (?, ?, ?, ?)",
    );
    const insertRun = db.prepare(
      "INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, status, requested_at, completed_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const base = Date.parse("2026-11-01T00:00:00Z");
    for (let t = 0; t < 2000; t++) {
      const sub = t % 4 !== 0;
      const payload = sub
        ? {
            lineage: { relationshipToParent: "subagent", rootThreadId: `t${t - (t % 4)}` },
            createdAt: new Date(base + t * 60_000).toISOString(),
          }
        : {};
      insertThread.run(
        `t${t}`,
        `Review task ${t}`,
        new Date(base).toISOString(),
        JSON.stringify(payload),
      );
    }
    for (let i = 0; i < 200_000; i++) {
      const start = base + i * 3_000;
      const thread = `t${i % 2000}`;
      insertRun.run(
        `r${i}`,
        thread,
        i % 7 === 0 ? "failed" : "completed",
        new Date(start).toISOString(),
        new Date(start + (i % 90) * 60_000).toISOString(),
        JSON.stringify({
          startedAt: new Date(start).toISOString(),
          modelSelection: { model: `m${i % 5}` },
        }),
      );
    }
    db.exec("COMMIT");
    db.close();
    const started = performance.now();
    const rows = readRows(path);
    const report = buildReport(rows.threads, rows.runs, {
      until: Date.parse("2026-11-10T00:00:00Z"),
      days: 14,
      top: 15,
    });
    renderJson(report);
    renderText(report);
    const elapsed = performance.now() - started;
    assert.equal(rows.runs.length, 200_000);
    assert.equal(report.totals.subagentTasks, 1500);
    assert.ok(elapsed < 3000, `took ${Math.round(elapsed)} ms`);
  });
});

describe("render", () => {
  const report = buildReport(
    [
      {
        thread_id: "lead",
        title: `Ünïcode ${"very long title ".repeat(10)}`,
        created_at: null,
        payload_json: null,
      },
    ],
    [
      {
        run_id: "r",
        thread_id: "lead",
        status: "completed",
        requested_at: "2026-11-09T00:00:00Z",
        completed_at: "2026-11-09T01:00:00Z",
        payload_json: '{"startedAt":"2026-11-09T00:00:00Z"}',
      },
    ],
    { until: Date.parse("2026-11-10T00:00:00Z"), days: 14, top: 15 },
  );

  it("prints decimal fields with a fractional part and escapes non-ASCII", () => {
    const json = renderJson(report);
    assert.match(json, /"leadHours": 1\.0,/);
    assert.match(json, /"subagentHours": 0\.0,/);
    assert.match(json, /"concurrency": 0\n/);
    assert.match(json, /"\\u00dcn\\u00efcode/);
    assert.deepEqual(JSON.parse(json), report);
  });

  it("keeps text tables within 100 columns", () => {
    const text = renderText(report);
    for (const heading of [
      "Totals",
      "Lead models",
      "Subagent models",
      "Top chats",
      "Subagent tasks by day",
    ]) {
      assert.ok(text.includes(`\n${heading}\n`), heading);
    }
    for (const line of text.split("\n")) assert.ok(line.length <= 100, line);
  });
});
