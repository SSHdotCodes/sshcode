// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Standalone synchronous Node/SQLite analytics, with no Effect runtime.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

export interface LiveReportOptions {
  dbPath?: string;
  days?: number;
  now?: Date;
  maxEvents?: number;
  maxThreads?: number;
  maxTasksPerThread?: number;
  maxRowsPerQuery?: number;
  maxQueries?: number;
  maxPayloadBytes?: number;
  maxTotalPayloadBytes?: number;
}

type Row = Record<string, NodeSqlite.SQLOutputValue>;
type Json = Record<string, unknown>;
type Distribution = { known: number; unknown: number; median: number | null; p90: number | null };
type Rate = { matches: number; denominator: number; unknown: number; rate: number | null };
type ToolRate = {
  tool: string;
  errors: number;
  denominator: number;
  unknown: number;
  rate: number | null;
};
export interface LiveMetrics {
  provider: string;
  model: string;
  completedTasks: number;
  tokens: Distribution;
  turns: Distribution;
  fixRoundsHeuristic: Distribution;
  finalProseOfferHeuristic: Rate;
  mcpErrors: ToolRate[];
}

export interface LiveReport {
  window: { from: string; to: string; days: number };
  source: "immutable read-only checkpoint; WAL excluded";
  serverVersion: { available: false; reason: string };
  bounds: {
    maxEvents: number;
    maxThreads: number;
    maxTasksPerThread: number;
    maxRowsPerQuery: number;
    maxQueries: number;
    maxPayloadBytes: number;
    maxTotalPayloadBytes: number;
  };
  coverage: {
    eventSequenceFrom: number;
    eventSequenceTo: number;
    events: number;
    earliestEventAt: string | null;
    threads: number;
    completedTasks: number;
    queries: number;
    parsedPayloadBytes: number;
    skippedPayloads: number;
    cappedPartitions: number;
    capped: boolean;
  };
  queryPlans: { query: string; details: string[] }[];
  groups: LiveMetrics[];
  daily: { date: string; groups: LiveMetrics[] }[];
  notes: string[];
}

const DAY = 86_400_000;
const obj = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
// Only schema metadata labels leave this module, never arbitrary text or payloads.
const label = (value: unknown) =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,159}$/u.test(value)
    ? value
    : "unknown";

function boundedOption(value: number | undefined, fallback: number, max: number) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) {
    throw new Error(`Expected an integer between 1 and ${max}.`);
  }
  return result;
}

function distribution(values: (number | null)[]): Distribution {
  const known = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  const middle = Math.floor(known.length / 2);
  return {
    known: known.length,
    unknown: values.length - known.length,
    median:
      known.length === 0
        ? null
        : known.length % 2 === 0
          ? (known[middle - 1]! + known[middle]!) / 2
          : known[middle]!,
    p90: known.length === 0 ? null : known[Math.ceil(known.length * 0.9) - 1]!,
  };
}

type TaskSample = {
  date: string;
  provider: string;
  model: string;
  tokens: number | null;
  turns: number | null;
  fixes: number | null;
  offer: boolean | null;
  tools: { id: string; tool: string; error: boolean | null }[];
};

function aggregate(samples: TaskSample[]): LiveMetrics[] {
  const groups = new Map<string, TaskSample[]>();
  for (const sample of samples) {
    const key = `${sample.provider}\0${sample.model}`;
    const group = groups.get(key) ?? [];
    group.push(sample);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((tasks) => {
      const offers = tasks.filter((task) => task.offer !== null);
      const matches = offers.filter((task) => task.offer).length;
      const tools = new Map<string, Map<string, boolean | null>>();
      for (const call of tasks.flatMap((task) => task.tools)) {
        const calls = tools.get(call.tool) ?? new Map<string, boolean | null>();
        calls.set(call.id, call.error);
        tools.set(call.tool, calls);
      }
      return {
        provider: tasks[0]!.provider,
        model: tasks[0]!.model,
        completedTasks: tasks.length,
        tokens: distribution(tasks.map((task) => task.tokens)),
        turns: distribution(tasks.map((task) => task.turns)),
        fixRoundsHeuristic: distribution(tasks.map((task) => task.fixes)),
        finalProseOfferHeuristic: {
          matches,
          denominator: offers.length,
          unknown: tasks.length - offers.length,
          rate: offers.length ? matches / offers.length : null,
        },
        mcpErrors: [...tools]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([tool, calls]) => {
            const values = [...calls.values()];
            const errors = values.filter((v) => v === true).length;
            const denominator = values.filter((v) => v !== null).length;
            return {
              tool,
              errors,
              denominator,
              unknown: values.length - denominator,
              rate: denominator ? errors / denominator : null,
            };
          }),
      };
    })
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}

/** Read a capped, checkpoint-only sample. All data statements are plan-checked before execution. */
export function readLiveReport(options: LiveReportOptions = {}): LiveReport {
  const days = boundedOption(options.days, 7, 31);
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid report time.");
  const to = now.toISOString();
  const from = new Date(now.getTime() - days * DAY).toISOString();
  const bounds = {
    maxEvents: boundedOption(options.maxEvents, 50_000, 200_000),
    maxThreads: boundedOption(options.maxThreads, 64, 256),
    maxTasksPerThread: boundedOption(options.maxTasksPerThread, 64, 256),
    maxRowsPerQuery: boundedOption(options.maxRowsPerQuery, 256, 1_024),
    maxQueries: boundedOption(options.maxQueries, 2_000, 5_000),
    maxPayloadBytes: boundedOption(options.maxPayloadBytes, 65_536, 262_144),
    maxTotalPayloadBytes: boundedOption(options.maxTotalPayloadBytes, 33_554_432, 67_108_864),
  };
  const report: LiveReport = {
    window: { from, to, days },
    source: "immutable read-only checkpoint; WAL excluded",
    serverVersion: {
      available: false,
      reason:
        "No per-run SSHCode server version in this schema; current app/provider versions are not historical server versions.",
    },
    bounds,
    coverage: {
      eventSequenceFrom: 0,
      eventSequenceTo: 0,
      events: 0,
      earliestEventAt: null,
      threads: 0,
      completedTasks: 0,
      queries: 0,
      parsedPayloadBytes: 0,
      skippedPayloads: 0,
      cappedPartitions: 0,
      capped: false,
    },
    queryPlans: [],
    groups: [],
    daily: [],
    notes: [
      "Checkpoint-only bounded sample, not a census. Immutable mode ignores WAL and assumes the main file stays stable; concurrent checkpoints can require retrying.",
      "Tasks must start and complete inside [from,to); in-flight, failed, cross-window and undiscovered tasks are excluded. No task IDs or message bodies are emitted.",
      "Tokens sum complete main_agent turnTokenUsage input+output only, excluding nested agents. Context occupancy is not token consumption. Missing/partial usage stays unknown.",
      "Turns count persisted provider turns attributed to a delegated task, including failed attempts. Mixed-model tasks are grouped as mixed; native turns use the task model.",
      "Fix rounds heuristic = max(0, completed attributed runs - 1), not verified corrections. Native tasks without attributed runs are unknown.",
      "Final prose-offer heuristic checks the last paragraph of the final non-streaming assistant message of the last completed run (or native task result). It detects English offers, not intent.",
      "MCP errors use identifiable MCP dynamic_tool items in sampled tasks: failed status or output.isError=true; completed=false otherwise. Nonterminal/cancelled/interrupted outcomes are unknown. Missing/capped payloads can omit tool identities.",
      "Daily groups use task completion date in UTC; comparisons are observational and affected by task mix and sample caps.",
    ],
  };
  const uri = NodeURL.pathToFileURL(
    NodePath.resolve(options.dbPath ?? `${NodeOS.homedir()}/.t3/userdata/statev2.sqlite`),
  );
  uri.search = "?mode=ro&immutable=1";
  const db = new NodeSqlite.DatabaseSync(uri, { readOnly: true, allowExtension: false });
  const plans = new Set<string>();
  const coverage = report.coverage;
  const cap = () => {
    coverage.capped = true;
    coverage.cappedPartitions++;
  };
  // These pragmas affect this connection only. Immutable + SQLITE_OPEN_READONLY prevents sidecar writes.
  const query = (name: string, sql: string, args: NodeSqlite.SQLInputValue[]): Row[] => {
    if (coverage.queries >= bounds.maxQueries) {
      cap();
      return [];
    }
    if (!plans.has(name)) {
      const details = db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...args)
        .map((r) => String(r.detail));
      if (
        details.some((detail) => /SCAN (?!bounded\b)|USE TEMP B-TREE|AUTOMATIC/iu.test(detail)) ||
        !details.some((detail) =>
          /SEARCH .+ USING (?:COVERING )?(?:INDEX|INTEGER PRIMARY KEY)/iu.test(detail),
        )
      ) {
        throw new Error(
          `Unsafe query plan for ${name}; no analytics queries were allowed to scan a table.`,
        );
      }
      plans.add(name);
      report.queryPlans.push({ query: name, details });
    }
    coverage.queries++;
    return db.prepare(sql).all(...args);
  };
  const parse = (row: Row): Json | null => {
    const raw = str(row.payload_json);
    if (raw === undefined) {
      coverage.skippedPayloads++;
      cap();
      return null;
    }
    const bytes = Buffer.byteLength(raw);
    if (
      bytes > bounds.maxPayloadBytes ||
      coverage.parsedPayloadBytes + bytes > bounds.maxTotalPayloadBytes
    ) {
      coverage.skippedPayloads++;
      cap();
      return null;
    }
    coverage.parsedPayloadBytes += bytes;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
        return obj(parsed);
      coverage.skippedPayloads++;
      return null;
    } catch {
      coverage.skippedPayloads++;
      return null;
    }
  };
  const payload =
    "CASE WHEN octet_length(payload_json)<=? THEN payload_json ELSE NULL END AS payload_json";
  // The materialized inner LIMIT bounds *examined* rows even when time is not indexed.
  const partition = (spec: {
    name: string;
    table: string;
    index: string;
    key: string;
    value: string;
    columns: string[];
    order: string;
    time?: string;
    start?: string;
    end?: string;
  }) => {
    const columns = [...spec.columns, "payload_json"];
    const timeFilter = spec.time ? `WHERE ${spec.time}>=? AND ${spec.time}<?` : "";
    const args: NodeSqlite.SQLInputValue[] = [
      bounds.maxPayloadBytes,
      spec.value,
      bounds.maxRowsPerQuery,
    ];
    if (spec.time) args.push(spec.start ?? from, spec.end ?? to);
    args.push(bounds.maxRowsPerQuery + 1);
    const rows = query(
      spec.name,
      `WITH bounded AS MATERIALIZED (
      SELECT ${spec.columns.join(",")}, ${payload} FROM ${spec.table} INDEXED BY ${spec.index}
      WHERE ${spec.key}=? ORDER BY ${spec.order} DESC LIMIT ?
    ) SELECT ${columns.join(",")}, 0 AS sampled FROM bounded ${timeFilter}
      UNION ALL SELECT ${columns.map(() => "NULL").join(",")}, COUNT(*) AS sampled FROM bounded LIMIT ?`,
      args,
    );
    const sampled = Number(rows.at(-1)?.sampled ?? 0);
    const complete = sampled < bounds.maxRowsPerQuery && rows.length > 0;
    if (!complete) cap();
    return { rows: rows.slice(0, -1), complete };
  };
  try {
    db.exec(
      "PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-4096;",
    );
    // sqlite_schema is small metadata, not application data. No PRAGMA migrations or introspection of values.
    const tables = new Set(
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('orchestration_events','orchestration_v2_projection_subagents','orchestration_v2_projection_runs','orchestration_v2_projection_provider_turns','orchestration_v2_projection_run_attempts','orchestration_v2_projection_turn_items') LIMIT 6",
        )
        .all()
        .map((r) => r.name),
    );
    if (tables.size !== 6)
      throw new Error("Unsupported analytics schema; required v2 tables are unavailable.");
    const latest = query(
      "event-high-water",
      "SELECT sequence FROM orchestration_events WHERE sequence>=0 ORDER BY sequence DESC LIMIT 1",
      [],
    );
    const high = Number(latest[0]?.sequence ?? 0);
    const low = Math.max(0, high - bounds.maxEvents);
    coverage.eventSequenceFrom = low + 1;
    coverage.eventSequenceTo = high;
    const events = query(
      "event-tail",
      `SELECT stream_id,occurred_at FROM orchestration_events
      WHERE sequence>? AND sequence<=? AND occurred_at>=? AND occurred_at<?
      AND application_event_version=2 AND aggregate_kind='thread'
      ORDER BY sequence DESC LIMIT ?`,
      [low, high, from, to, bounds.maxEvents],
    );
    coverage.events = events.length;
    coverage.earliestEventAt = events.reduce<string | null>((min, row) => {
      const at = String(row.occurred_at);
      return min === null || at < min ? at : min;
    }, null);
    // Even if fewer events match time/type, a sequence budget cannot prove earlier coverage.
    if (low > 0) cap();
    const allThreads = [...new Set(events.map((row) => String(row.stream_id)))];
    if (allThreads.length > bounds.maxThreads) cap();
    const threads = allThreads.slice(0, bounds.maxThreads);
    coverage.threads = threads.length;
    const samples: TaskSample[] = [];
    const seen = new Set<string>();
    for (const thread of threads) {
      const tasks = query(
        "tasks-by-thread-time",
        `SELECT subagent_id,provider,provider_thread_id,child_thread_id,origin,status,started_at,completed_at,${payload}
        FROM orchestration_v2_projection_subagents INDEXED BY orchestration_v2_projection_subagents_thread_idx
        WHERE thread_id=? AND started_at>=? AND started_at<? ORDER BY started_at DESC,subagent_id DESC LIMIT ?`,
        [bounds.maxPayloadBytes, thread, from, to, bounds.maxTasksPerThread],
      );
      if (tasks.length === bounds.maxTasksPerThread) cap();
      for (const task of tasks) {
        const id = String(task.subagent_id);
        const start = str(task.started_at);
        const end = str(task.completed_at);
        if (
          seen.has(id) ||
          task.status !== "completed" ||
          !start ||
          !end ||
          end < start ||
          end < from ||
          end >= to
        )
          continue;
        seen.add(id);
        const data = parse(task);
        const sample: TaskSample = {
          date: end.slice(0, 10),
          provider: label(task.provider),
          model: label(obj(data?.modelSelection).model ?? data?.model),
          tokens: null,
          turns: null,
          fixes: null,
          offer: null,
          tools: [],
        };
        samples.push(sample);
        // End is inclusive for task-local records; the overall report window is half-open.
        const taskEnd = new Date(Date.parse(end) + 1).toISOString();
        const child = str(task.child_thread_id);
        const runs = child
          ? partition({
              name: "child-runs",
              table: "orchestration_v2_projection_runs",
              index: "orchestration_v2_projection_runs_thread_ordinal_idx",
              key: "thread_id",
              value: child,
              columns: [
                "run_id",
                "provider",
                "provider_thread_id",
                "status",
                "requested_at",
                "completed_at",
                "ordinal",
              ],
              order: "ordinal",
              time: "requested_at",
              start,
              end: taskEnd,
            })
          : { rows: [], complete: true };
        const parsedRuns = runs.rows.map((row) => ({ row, data: parse(row) }));
        const attributed = parsedRuns.filter((run) => run.data?.delegatedTaskId === id);
        const runModels = new Set(
          attributed.map((run) => label(obj(run.data?.modelSelection).model)),
        );
        const runProviders = new Set(attributed.map((run) => label(run.row.provider)));
        if (runModels.size) sample.model = runModels.size === 1 ? [...runModels][0]! : "mixed";
        if (runProviders.size)
          sample.provider = runProviders.size === 1 ? [...runProviders][0]! : "mixed";
        const completeRuns = attributed.filter(
          (run) =>
            run.row.status === "completed" &&
            str(run.row.completed_at) &&
            String(run.row.completed_at) <= end,
        );
        let complete =
          runs.complete && parsedRuns.every((run) => run.data !== null) && attributed.length > 0;
        if (complete && completeRuns.length) sample.fixes = Math.max(0, completeRuns.length - 1);
        const attempts = new Set<string>();
        const providerThreads = new Set<string>();
        for (const run of attributed) {
          const found = partition({
            name: "run-attempts",
            table: "orchestration_v2_projection_run_attempts",
            index: "orchestration_v2_projection_run_attempts_run_ordinal_idx",
            key: "run_id",
            value: String(run.row.run_id),
            columns: ["attempt_id", "attempt_ordinal", "provider_thread_id"],
            order: "attempt_ordinal",
          });
          complete &&= found.complete && found.rows.length > 0;
          for (const attempt of found.rows) {
            attempts.add(String(attempt.attempt_id));
            if (str(attempt.provider_thread_id))
              providerThreads.add(String(attempt.provider_thread_id));
          }
        }
        const native =
          task.origin === "provider_native" &&
          attributed.length === 0 &&
          str(task.provider_thread_id);
        if (native) {
          providerThreads.add(String(task.provider_thread_id));
          complete = runs.complete;
        }
        const turns: { row: Row; data: Json | null }[] = [];
        for (const providerThread of providerThreads) {
          const found = partition({
            name: "provider-turns",
            table: "orchestration_v2_projection_provider_turns",
            index: "orchestration_v2_projection_provider_turns_thread_ordinal_idx",
            key: "provider_thread_id",
            value: providerThread,
            columns: [
              "provider_turn_id",
              "run_attempt_id",
              "ordinal",
              "started_at",
              "completed_at",
              "status",
            ],
            order: "ordinal",
            time: "started_at",
            start,
            end: taskEnd,
          });
          complete &&= found.complete;
          for (const row of found.rows) {
            if (native || attempts.has(String(row.run_attempt_id)))
              turns.push({ row, data: parse(row) });
          }
        }
        if (
          !native &&
          [...attempts].some((id) => !turns.some((turn) => turn.row.run_attempt_id === id))
        )
          complete = false;
        if (complete && turns.length) {
          sample.turns = turns.length;
          let tokens = 0;
          let known = true;
          for (const turn of turns) {
            const usage = obj(turn.data?.turnTokenUsage);
            const input = count(usage.inputTokens);
            const output = count(usage.outputTokens);
            if (
              turn.row.status !== "completed" ||
              !str(turn.row.completed_at) ||
              String(turn.row.completed_at) > end ||
              usage.usageStatus !== "complete" ||
              usage.usageScope !== "main_agent" ||
              input === undefined ||
              output === undefined
            )
              known = false;
            else tokens += input + output;
          }
          if (known && Number.isSafeInteger(tokens)) sample.tokens = tokens;
        }
        // Item queries are bounded by an already time-selected run/turn, then by updated_at.
        const finalRun = completeRuns.sort(
          (a, b) => Number(b.row.ordinal) - Number(a.row.ordinal),
        )[0];
        let finalText: string | undefined;
        let itemsComplete = true;
        const itemKeys = native
          ? turns.map((turn) => ({
              key: "provider_turn_id",
              value: String(turn.row.provider_turn_id),
            }))
          : attributed.map((run) => ({ key: "run_id", value: String(run.row.run_id) }));
        for (const itemKey of itemKeys) {
          const found = partition({
            name: native ? "native-items" : "run-items",
            table: "orchestration_v2_projection_turn_items",
            index: native
              ? "orchestration_v2_projection_turn_items_provider_turn_idx"
              : "orchestration_v2_projection_turn_items_run_ordinal_idx",
            ...itemKey,
            columns: ["turn_item_id", "ordinal", "type", "status", "updated_at"],
            // The provider-turn index has no ordinal; rowid order permits a capped index walk without sorting.
            order: native ? "rowid" : "ordinal",
            time: "updated_at",
            start,
            end: taskEnd,
          });
          itemsComplete &&= found.complete;
          let lastOrdinal = -1;
          for (const row of found.rows) {
            const item = parse(row);
            if (!item) {
              itemsComplete = false;
              continue;
            }
            if (row.type === "dynamic_tool") {
              const name = str(item.toolName);
              const source = obj(item.toolSource);
              if (
                name &&
                (name.startsWith("mcp__") ||
                  source.kind === "integration" ||
                  str(source.key)?.startsWith("mcp:"))
              ) {
                const error =
                  row.status === "failed" || obj(item.output).isError === true
                    ? true
                    : row.status === "completed"
                      ? false
                      : null;
                sample.tools.push({ id: String(row.turn_item_id), tool: label(name), error });
              }
            }
            if (
              itemKey.value === finalRun?.row.run_id &&
              row.type === "assistant_message" &&
              item.streaming === false &&
              item.textOmitted !== true &&
              str(item.text)?.trim() &&
              Number(row.ordinal) > lastOrdinal
            ) {
              finalText = String(item.text);
              lastOrdinal = Number(row.ordinal);
            }
          }
        }
        if (native) finalText = str(data?.result);
        if (
          itemsComplete &&
          runs.complete &&
          parsedRuns.every((run) => run.data !== null) &&
          (attributed.length > 0 || native) &&
          finalText?.trim()
        ) {
          const paragraph = finalText
            .trim()
            .split(/\n\s*\n/u)
            .at(-1)!
            .slice(-2_000);
          sample.offer =
            /\b(?:if (?:you(?:'d| would)? (?:want|like)|needed)|(?:i can|i could|would you like me to|want me to|let me know if))\b/iu.test(
              paragraph,
            );
        }
      }
    }
    coverage.completedTasks = samples.length;
    report.groups = aggregate(samples);
    const dates = [...new Set(samples.map((sample) => sample.date))].sort();
    report.daily = dates.map((date) => ({
      date,
      groups: aggregate(samples.filter((sample) => sample.date === date)),
    }));
    if (coverage.capped)
      report.notes.push(
        "At least one discovery/query/payload cap was reached. Results describe the bounded sample only; unavailable task metrics are not zero.",
      );
    if (coverage.skippedPayloads)
      report.notes.push(
        "Some payloads were oversized, malformed, or over the parse budget; metric coverage and tool denominators may be incomplete.",
      );
    return report;
  } finally {
    db.close();
  }
}

/** Render only aggregates and fixed diagnostics. */
export function renderLiveMarkdown(report: LiveReport): string {
  const number = (value: number | null) => (value === null ? "unavailable" : String(value));
  const dist = (value: Distribution) =>
    `${number(value.median)} / ${number(value.p90)} (n=${value.known}, unknown=${value.unknown})`;
  const rate = (value: Rate) =>
    `${value.matches}/${value.denominator} (${value.rate === null ? "unavailable" : `${(value.rate * 100).toFixed(1)}%`}, unknown=${value.unknown})`;
  const table = (groups: LiveMetrics[]) =>
    [
      "| Provider | Model | Tasks | Tokens median / p90 | Turns median / p90 | Fix rounds heuristic median / p90 | Final prose-offer heuristic |",
      "| --- | --- | ---: | --- | --- | --- | --- |",
      ...groups.map(
        (g) =>
          `| ${g.provider} | ${g.model} | ${g.completedTasks} | ${dist(g.tokens)} | ${dist(g.turns)} | ${dist(g.fixRoundsHeuristic)} | ${rate(g.finalProseOfferHeuristic)} |`,
      ),
    ].join("\n");
  return [
    "# Live agent efficiency (bounded sample)",
    "",
    `${report.window.from} to ${report.window.to} (exclusive). Source: ${report.source}.`,
    "",
    `Coverage: ${report.coverage.events} events, ${report.coverage.threads} threads, ${report.coverage.completedTasks} completed tasks; capped=${report.coverage.capped}.`,
    `Server-version grouping unavailable: ${report.serverVersion.reason}`,
    "",
    table(report.groups),
    "",
    "## MCP error rates (sampled tasks)",
    "",
    "| Provider | Model | Tool | Errors / terminal calls | Unknown outcomes |",
    "| --- | --- | --- | --- | ---: |",
    ...report.groups.flatMap((g) =>
      g.mcpErrors.map(
        (t) =>
          `| ${g.provider} | ${g.model} | ${t.tool} | ${t.errors}/${t.denominator} (${t.rate === null ? "unavailable" : `${(t.rate * 100).toFixed(1)}%`}) | ${t.unknown} |`,
      ),
    ),
    "",
    "## Daily trend (UTC completion date)",
    "",
    ...report.daily.flatMap((day) => [`### ${day.date}`, "", table(day.groups), ""]),
    "## Query bounds",
    "",
    `Sequence range ${report.coverage.eventSequenceFrom}..${report.coverage.eventSequenceTo}; earliest sampled event ${report.coverage.earliestEventAt ?? "unavailable"}.`,
    `Limits: ${JSON.stringify(report.bounds)}. Executed ${report.coverage.queries} data queries; parsed ${report.coverage.parsedPayloadBytes} payload bytes; skipped ${report.coverage.skippedPayloads} payloads.`,
    "",
    ...report.notes.map((note) => `- ${note}`),
    "",
  ].join("\n");
}

if (
  process.argv[1] &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href
) {
  try {
    const options: LiveReportOptions = {};
    let json = false;
    for (let i = 2; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg === "--json") json = true;
      else if (arg === "--db") {
        const value = process.argv[++i];
        if (!value || value.startsWith("--")) throw new Error("Missing database path.");
        options.dbPath = value;
      } else if (arg === "--days") options.days = Number(process.argv[++i]);
      else
        throw new Error(
          "Usage: node scripts/agent-quality/live.ts [--db PATH] [--days 1..31] [--json]",
        );
    }
    const report = readLiveReport(options);
    process.stdout.write(
      json ? `${JSON.stringify(report, null, 2)}\n` : renderLiveMarkdown(report),
    );
  } catch {
    // SQLite errors can contain paths or payload details; keep CLI errors fixed and secret-free.
    process.stderr.write(
      "Live report failed: check CLI arguments, schema/index compatibility, and database readability. No writes were requested.\n",
    );
    process.exitCode = 1;
  }
}
