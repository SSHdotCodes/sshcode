// Output formatting: JSON with fixed-precision numbers, and aligned text tables.
import type { Report } from "./report.ts";

// Keys whose values are rounded decimals; they always print with a fractional part ("0.0").
// `concurrency` stays a bare 0 when a chat has no measurable subagent time.
const DECIMAL_KEYS = new Set([
  "hours",
  "leadHours",
  "subagentHours",
  "medianMinutes",
  "followUpsPerTask",
  "concurrency",
]);

function formatNumber(key: string, value: number): string {
  const text = String(value);
  if (!DECIMAL_KEYS.has(key) || !Number.isInteger(value)) return text;
  if (key === "concurrency" && value === 0) return "0";
  return `${text}.0`;
}

function formatString(value: string): string {
  return JSON.stringify(value).replace(
    /[\u0080-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function formatValue(value: unknown, key: string, indent: string): string {
  if (typeof value === "number") return formatNumber(key, value);
  if (typeof value === "string") return formatString(value);
  if (value === null || typeof value === "boolean") return String(value);
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value.map((v) => inner + formatValue(v, key, inner)).join(",\n")}\n${indent}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  return `{\n${entries
    .map(([k, v]) => `${inner}${formatString(k)}: ${formatValue(v, k, inner)}`)
    .join(",\n")}\n${indent}}`;
}

/** The report as indented JSON, ending in a newline. */
export function renderJson(report: Report): string {
  return `${formatValue(report, "", "")}\n`;
}

type Align = "left" | "right";
interface Column {
  header: string;
  align: Align;
}

function cut(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

function table(columns: Column[], rows: string[][]): string {
  if (rows.length === 0) return "  (none)";
  const widths = columns.map((c, i) =>
    Math.max(c.header.length, ...rows.map((r) => r[i]?.length ?? 0)),
  );
  const line = (cells: string[]) =>
    `  ${cells
      .map((cell, i) =>
        columns[i]?.align === "left" ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!),
      )
      .join("  ")
      .trimEnd()}`;
  return [
    line(columns.map((c) => c.header)),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map(line),
  ].join("\n");
}

const L = (header: string): Column => ({ header, align: "left" });
const R = (header: string): Column => ({ header, align: "right" });
const f1 = (n: number) => n.toFixed(1);

/** The report as aligned text tables that fit in 100 columns. */
export function renderText(report: Report): string {
  const { window, totals } = report;
  const sections = [
    `Usage from ${window.since} to ${window.until} (${window.days} days)`,
    "Totals",
    table(
      [L("Metric"), R("Value")],
      [
        ["Lead chats", String(totals.leadChats)],
        ["Lead chats with subagents", String(totals.leadChatsWithSubagents)],
        ["Lead hours", f1(totals.leadHours)],
        ["Subagent tasks", String(totals.subagentTasks)],
        ["Subagent hours", f1(totals.subagentHours)],
      ],
    ),
    "Lead models",
    table(
      [L("Model"), R("Runs"), R("Chats"), R("Done"), R("Failed"), R("Stopped"), R("Hours")],
      report.leadModels.map((m) => [
        cut(m.model, 32),
        String(m.runs),
        String(m.chats),
        String(m.completed),
        String(m.failed),
        String(m.stopped),
        f1(m.hours),
      ]),
    ),
    "Subagent models",
    table(
      [
        L("Model"),
        R("Tasks"),
        R("Median min"),
        R("<3m"),
        R("3-20m"),
        R("20-60m"),
        R(">=60m"),
        R("Follow-ups"),
        R("Hours"),
      ],
      report.subagentModels.map((m) => [
        cut(m.model, 24),
        String(m.tasks),
        f1(m.medianMinutes),
        String(m.under3),
        String(m.from3to20),
        String(m.from20to60),
        String(m.over60),
        f1(m.followUpsPerTask),
        f1(m.hours),
      ]),
    ),
    "Top chats",
    table(
      [L("Chat"), L("Lead model"), R("Turns"), R("Lead h"), R("Tasks"), R("Sub h"), R("Conc")],
      report.chats.map((c) => [
        cut(c.title || c.threadId, 36),
        cut(c.leadModel, 16),
        String(c.turns),
        f1(c.leadHours),
        String(c.subagentTasks),
        f1(c.subagentHours),
        c.concurrency.toFixed(2),
      ]),
    ),
    "Subagent tasks by day",
    table(
      [L("Day (New York)"), R("Tasks"), R("Reviews")],
      report.days.map((d) => [d.day, String(d.subagentTasks), String(d.reviews)]),
    ),
  ];
  return `${sections.join("\n\n").replace(/\n\n(  )/g, "\n$1")}\n`;
}
