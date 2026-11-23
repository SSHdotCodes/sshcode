// @effect-diagnostics globalDate:off - CLI boundary supplies the default report timestamp.
// Usage: node scripts/usage-report/cli.ts --db <path> [--days N] [--until <ISO time>] [--top N] [--json]
import { readRows } from "./db.ts";
import { buildReport, parseTime } from "./report.ts";
import { renderJson, renderText } from "./render.ts";

const USAGE =
  "usage: node scripts/usage-report/cli.ts --db <path> [--days N] [--until <ISO time>] [--top N] [--json]";

export interface CliOptions {
  db: string;
  days: number;
  until: number;
  top: number;
  json: boolean;
  help: boolean;
}

export class UsageError extends Error {}

function nonNegativeInteger(flag: string, value: string): number {
  if (!/^\d+$/.test(value))
    throw new UsageError(`${flag} must be a non-negative integer, got "${value}"`);
  return Number(value);
}

/** Parses CLI arguments; throws UsageError on anything invalid. */
export function parseArgs(argv: string[], now: number = Date.now()): CliOptions {
  const options: CliOptions = { db: "", days: 14, until: now, top: 15, json: false, help: false };
  let dbGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const flag = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    const inline = arg.startsWith("--") && eq > 0 ? arg.slice(eq + 1) : undefined;
    const takeValue = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--"))
        throw new UsageError(`${flag} needs a value`);
      i++;
      return next;
    };
    switch (flag) {
      case "--db":
        options.db = takeValue();
        dbGiven = true;
        break;
      case "--days":
        options.days = nonNegativeInteger(flag, takeValue());
        break;
      case "--top":
        options.top = nonNegativeInteger(flag, takeValue());
        break;
      case "--until": {
        const value = takeValue();
        const parsed = parseTime(value);
        if (parsed === null)
          throw new UsageError(`--until must be an ISO 8601 time, got "${value}"`);
        options.until = parsed;
        break;
      }
      case "--json":
        if (inline !== undefined) throw new UsageError("--json takes no value");
        options.json = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new UsageError(`unknown argument "${arg}"`);
    }
  }
  if (!options.help && (!dbGiven || options.db === "")) throw new UsageError("missing --db <path>");
  return options;
}

function fail(message: string): never {
  process.stderr.write(`usage-report: ${message.replace(/\s+/g, " ").trim()}\n`);
  process.exit(2);
}

function main(): void {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) fail(error.message);
    throw error;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  let rows: ReturnType<typeof readRows>;
  try {
    rows = readRows(options.db);
  } catch (error) {
    fail(
      `cannot read database ${options.db}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const report = buildReport(rows.threads, rows.runs, {
    until: options.until,
    days: options.days,
    top: options.top,
  });
  process.stdout.write(options.json ? renderJson(report) : renderText(report));
}

if (import.meta.main) main();
