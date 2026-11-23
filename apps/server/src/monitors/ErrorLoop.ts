import * as Schema from "effect/Schema";

/**
 * Notices a running job stuck repeating one error, such as a remote container
 * that crashes at startup and is retried while the local command waits. Pure
 * and synchronous: a monitor feeds it output lines and asks for a wake while
 * the job still runs.
 *
 * Tuned on past durable job logs: a wake needs the same error three times and
 * once more at least CONFIRM_MS after the third. Bursts (parallel workers
 * failing together), retries that recovered and batches that end soon after
 * their failures never qualify; their exit notice already says enough.
 */

// eslint-disable-next-line no-control-regex -- terminal escapes are control characters.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const TRACEBACK = /^Traceback \(most recent call last\):/;
/** The exception line that ends a Python traceback: `pkg.Name` or `pkg.Name: message`. */
const PYTHON_EXCEPTION = /^[A-Za-z_][\w.]*(?:: .*)?$/;
const ERROR_LINE =
  /\b(?:[A-Z]\w*)?(?:Error|Exception)\b:|\berror(?:\[[\w-]+\])?:|\bERROR\b|\bFATAL\b|\bfatal:|\bpanic:|\bfailed (?:during|at|on) (?:startup|start|boot|launch)\b/;

export const REPEATS = 3;
/** The error must still recur this long after its third occurrence. */
export const CONFIRM_MS = 120_000;
/** A second wake when the same error still repeats this long after the first. */
export const REWAKE_AFTER_MS = 30 * 60_000;
const MAX_ENTRIES = 32;
const LINE_LIMIT = 120;

/** Same error, different attempt: drop times, ids, numbers, hex and the variable part of paths. */
export const normalizeErrorLine = (line: string) =>
  line
    .replace(ANSI, "")
    .replace(UUID, "<id>")
    .replace(
      /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g,
      "<time>",
    )
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, "<time>")
    .replace(/(?:[A-Za-z]:)?[~.]{0,2}(?:[\\/][\w.@+-]+)+[\\/]?/g, (path) => {
      const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
      return parts.length <= 1 ? path : `…/${parts.at(-1)}`;
    })
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,}\b/gi, "<hex>")
    .replace(/\b(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{12,}\b/g, "<id>")
    .replace(/\d+(?:\.\d+)*/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 160);

/**
 * A log line fit for a wake: escapes removed, credentials and long tokens
 * (keys, ids, hashes) redacted, at most 120 characters.
 */
export const displayLine = (raw: string) => {
  const line = raw
    .replace(ANSI, "")
    .replace(/(\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1<redacted>@")
    .replace(/\b(bearer)\s+\S+/gi, "$1 <redacted>")
    // `HF_TOKEN=…`, `api_key: …`, `Authorization: Basic …`; a bearer value went above.
    .replace(
      /\b(\w*?(?:key|token|secret|password|passwd|credentials?)|authorization)(["']?\s*[:=]\s*["']?)(?!bearer\s)(?:basic\s+)?[^\s"',;&]+/gi,
      "$1$2<redacted>",
    )
    .replace(UUID, "<id>")
    .replace(/(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{20,}/g, "<id>")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > LINE_LIMIT ? `${line.slice(0, LINE_LIMIT - 1)}…` : line;
};

/** The last non-empty line of some output, ready for a wake. */
export const lastOutputLine = (output: string) => {
  const lines = output.split(/[\r\n]+/);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = displayLine(lines[index]!);
    if (line.length > 0) return line;
  }
  return undefined;
};

/** Per-stream context: a Python traceback's frames are not errors, its last line is. */
export interface ErrorLineContext {
  traceback: boolean;
}

/** The error a line reports, as printed (escapes removed), or undefined. */
export const errorLine = (raw: string, context: ErrorLineContext): string | undefined => {
  const line = (raw.includes("\u001b") ? raw.replace(ANSI, "") : raw).trimEnd();
  if (TRACEBACK.test(line.trimStart())) {
    context.traceback = true;
    return undefined;
  }
  if (context.traceback) {
    if (line.length === 0 || /^\s/.test(line)) return undefined;
    context.traceback = false;
    if (PYTHON_EXCEPTION.test(line)) return line;
  }
  return ERROR_LINE.test(line) ? line.trim() : undefined;
};

/** One error line's history, saved with its monitor so a restart never wakes for it twice. */
export const ErrorLoopEntry = Schema.Struct({
  key: Schema.String,
  line: Schema.String,
  count: Schema.Number,
  since: Schema.Number,
  last: Schema.Number,
  /** When the count reached REPEATS. */
  reached: Schema.optional(Schema.Number),
  woke: Schema.optional(
    Schema.Struct({ at: Schema.Number, count: Schema.Number, again: Schema.Boolean }),
  ),
});
export type ErrorLoopEntry = typeof ErrorLoopEntry.Type;

export interface ErrorLoopWake {
  readonly line: string;
  readonly count: number;
  readonly since: number;
  readonly last: number;
}

type MutableEntry = { -readonly [K in keyof ErrorLoopEntry]: ErrorLoopEntry[K] };

export const makeDetector = (options: {
  /** One more wake when the same error still repeats REWAKE_AFTER_MS after the first. */
  readonly rewake: boolean;
  readonly saved?: ReadonlyArray<ErrorLoopEntry> | undefined;
}) => {
  const entries = new Map<string, MutableEntry>(
    (options.saved ?? []).map((entry) => [entry.key, { ...entry }]),
  );
  const contexts = new Map<string, ErrorLineContext>();
  const observe = (lines: ReadonlyArray<string>, now: number, stream = "output") => {
    let context = contexts.get(stream);
    if (context === undefined) contexts.set(stream, (context = { traceback: false }));
    for (const raw of lines) {
      const line = errorLine(raw, context);
      if (line === undefined) continue;
      const key = normalizeErrorLine(line);
      if (key.length === 0) continue;
      const entry = entries.get(key) ?? { key, line: "", count: 0, since: now, last: now };
      // Most recently seen last, so eviction drops the stalest line.
      entries.delete(key);
      entry.count += 1;
      entry.last = now;
      entry.line = displayLine(line);
      if (entry.count === REPEATS) entry.reached = now;
      entries.set(key, entry);
      if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
    }
  };
  /** The wake due, if any, which then counts as sent. Ask only while the job runs. */
  const take = (now: number): ErrorLoopWake | undefined => {
    let first: MutableEntry | undefined;
    for (const entry of entries.values())
      if (
        entry.woke === undefined &&
        entry.reached !== undefined &&
        entry.last - entry.reached >= CONFIRM_MS &&
        (first === undefined || entry.since < first.since)
      )
        first = entry;
    if (first !== undefined) {
      // A loop prints several error lines each round; this wake covers all seen during it.
      for (const entry of entries.values())
        if (entry.woke === undefined && entry.last >= first.since)
          entry.woke = { at: now, count: entry.count, again: !options.rewake };
      return { ...first };
    }
    let again: MutableEntry | undefined;
    for (const entry of entries.values())
      if (
        entry.woke?.again === false &&
        entry.last >= entry.woke.at + REWAKE_AFTER_MS &&
        entry.count - entry.woke.count >= REPEATS &&
        (again === undefined || entry.since < again.since)
      )
        again = entry;
    if (again === undefined) return undefined;
    const since = again.woke!.at;
    for (const entry of entries.values())
      if (entry.woke !== undefined && entry.last >= since)
        entry.woke = { ...entry.woke, again: true };
    return { ...again };
  };
  /** What a restart needs; lines seen once are cheap to lose. */
  const snapshot = (): ReadonlyArray<ErrorLoopEntry> =>
    [...entries.values()]
      .filter((entry) => entry.count > 1 || entry.woke !== undefined)
      .map((entry) => ({ ...entry }));
  return { observe, take, snapshot };
};

export const formatDuration = (ms: number) =>
  ms >= 3_600_000
    ? `${Math.round(ms / 360_000) / 10} h`
    : `${Math.max(1, Math.round(ms / 60_000))} min`;

/** The one-line wake for a job repeating an error. */
export const loopSummary = (wake: ErrorLoopWake) =>
  `still running, same error ${wake.count}× in ${formatDuration(wake.last - wake.since)}: ${wake.line}`;

/** When a job expected to take `expectMinutes` counts as overdue. */
export const overdueAfterMs = (expectMinutes: number) =>
  Math.max(1.5 * expectMinutes, expectMinutes + 10) * 60_000;

/** The one-line wake for a job still running well past its expected duration. */
export const overdueSummary = (input: {
  readonly ranMs: number;
  readonly expectMinutes: number;
  readonly lastLine: string | undefined;
}) =>
  `still running after ${formatDuration(input.ranMs)} (expected ${input.expectMinutes} min); ${
    input.lastLine === undefined ? "no output yet" : `last output: ${input.lastLine}`
  }`;
