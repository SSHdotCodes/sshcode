// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off -- Read-only Node CLI with an explicit input archive and wall-clock cutoff.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { usageWindowForecast, recentUsageRunOut } from "@t3tools/shared/usageLimitForecast";
import { isUsageWindowLimited } from "@t3tools/shared/usageLimits";
import {
  readUsageLimitRecordings,
  USAGE_LIMIT_RECORDING_HEARTBEAT_MS,
  USAGE_LIMIT_RECORDING_MAX_BYTES,
  type RecordedUsageLimitReading,
} from "../src/provider/usageLimitRecorder.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// The archive repeats an unmoved counter once per heartbeat, so a counter with no row for longer
// than that (plus one five-minute check) was not being read.
const SEEN_WITHIN_MS = USAGE_LIMIT_RECORDING_HEARTBEAT_MS + 5 * 60_000;
const CHECKPOINTS = [25, 50, 75] as const;
const RULES = ["current", "average", "recent"] as const;
type Rule = (typeof RULES)[number];
type Axis = "used" | "elapsed";

function duration(row: RecordedUsageLimitReading): number | null {
  if (row.windowDurationMins !== undefined) return row.windowDurationMins * 60_000;
  if (row.kind === "session") return 5 * HOUR;
  if (row.kind === "weekly") return 7 * DAY;
  if (row.kind !== "monthly" || !row.resetsAt) return null;
  const start = new Date(row.resetsAt);
  start.setMonth(start.getMonth() - 1);
  return Date.parse(row.resetsAt) - start.getTime();
}

const windowOf = (row: RecordedUsageLimitReading) => ({
  id: row.windowId,
  label: row.kind,
  kind: row.kind,
  usedPercent: row.usedPercent,
  ...(row.resetsAt === undefined ? {} : { resetsAt: row.resetsAt }),
  ...(row.windowDurationMins === undefined ? {} : { windowDurationMins: row.windowDurationMins }),
  ...(row.limited === undefined ? {} : { limited: row.limited }),
  ...(row.recentPercentPerHour === undefined
    ? {}
    : { recentPercentPerHour: row.recentPercentPerHour }),
});

function predictedAt(row: RecordedUsageLimitReading, now: number, rule: Rule): number | null {
  const window = windowOf(row);
  if (rule === "recent") return recentUsageRunOut(window, now);
  const { recentPercentPerHour: _recent, ...average } = window;
  const forecast = usageWindowForecast(rule === "average" ? average : window, now);
  return forecast?.kind === "runsOut" ? forecast.at : null;
}

const median = (values: readonly number[]): number | null => {
  const ordered = [...values].sort((a, b) => a - b);
  if (ordered.length === 0) return null;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
};

interface Period {
  rows: RecordedUsageLimitReading[];
  reset: number;
  interrupted: boolean;
}

/** Compare forecasts without using later readings to set a checkpoint's pace. */
export function backtestUsageLimits(readings: readonly RecordedUsageLimitReading[], now: number) {
  const byWindow = new Map<string, Period[]>();
  for (const row of [...readings].sort(
    (a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt),
  )) {
    if (!row.resetsAt || Date.parse(row.checkedAt) > now) continue;
    const key = `${row.driver}:${row.instanceId}:${row.windowId}`;
    const periods = byWindow.get(key) ?? [];
    byWindow.set(key, periods);
    const previous = periods.at(-1);
    const last = previous?.rows.at(-1);
    const reset = Date.parse(row.resetsAt);
    const changedReset = previous !== undefined && Math.abs(reset - previous.reset) > 10 * 60_000;
    const dropped = last !== undefined && row.usedPercent < last.usedPercent - 5;
    if (!previous || changedReset || dropped) {
      // Moving rolling resets and early/manual counter restarts have no known opening time.
      const early =
        previous !== undefined && Date.parse(row.checkedAt) < previous.reset - 10 * 60_000;
      if (previous && early) previous.interrupted = true;
      periods.push({ rows: [row], reset, interrupted: early });
    } else {
      previous.rows.push(row);
    }
  }
  const finished = [...byWindow.values()]
    .flat()
    .filter((period) => !period.interrupted && period.reset <= now);
  const buckets = new Map<
    string,
    {
      driver: string;
      axis: Axis;
      checkpoint: number;
      rule: Rule;
      errors: number[];
      gaps: number[];
      falseAlarms: number;
      missedExhaustions: number;
      censored: number;
    }
  >();
  for (const period of finished) {
    const rows = period.rows;
    const first = rows[0]!;
    const exhausted = rows.find(
      (row) => Date.parse(row.checkedAt) < period.reset && isUsageWindowLimited(windowOf(row)),
    );
    const actual = exhausted ? Date.parse(exhausted.checkedAt) : null;
    const beforeOut =
      actual === null ? undefined : rows.findLast((row) => Date.parse(row.checkedAt) < actual);
    const gap =
      actual === null || !beforeOut ? null : (actual - Date.parse(beforeOut.checkedAt)) / HOUR;
    const final = rows.findLast((row) => Date.parse(row.checkedAt) < period.reset);
    // Without a near-reset observation, "never saw it empty" is not evidence it lasted.
    const lasted =
      actual === null &&
      final !== undefined &&
      period.reset - Date.parse(final.checkedAt) <= SEEN_WITHIN_MS;
    for (const axis of ["used", "elapsed"] as const)
      for (const checkpoint of CHECKPOINTS) {
        let sample: RecordedUsageLimitReading | undefined;
        let at: number | undefined;
        if (axis === "used") {
          // If recording began above this share, its checkpoint was never observed.
          if (first.usedPercent <= checkpoint)
            sample = rows.find((row) => row.usedPercent >= checkpoint);
          if (sample && sample.usedPercent - checkpoint > 5) sample = undefined;
          at = sample ? Date.parse(sample.checkedAt) : undefined;
        } else {
          const length = duration(first);
          if (length !== null && length > 0) {
            at = period.reset - length * (1 - checkpoint / 100);
            sample = rows.findLast((row) => Date.parse(row.checkedAt) <= at!);
            // Skip stale checkpoints rather than judge a forecast from a long-unseen counter.
            if (sample && at - Date.parse(sample.checkedAt) > SEEN_WITHIN_MS) sample = undefined;
          }
        }
        for (const rule of RULES) {
          const key = `${first.driver}:${axis}:${checkpoint}:${rule}`;
          let bucket = buckets.get(key);
          if (!bucket) {
            bucket = {
              driver: first.driver,
              axis,
              checkpoint,
              rule,
              errors: [],
              gaps: [],
              falseAlarms: 0,
              missedExhaustions: 0,
              censored: 0,
            };
            buckets.set(key, bucket);
          }
          if (
            !sample ||
            at === undefined ||
            at >= period.reset ||
            isUsageWindowLimited(windowOf(sample)) ||
            (actual !== null && at >= actual)
          )
            continue;
          const predicted = predictedAt(sample, at, rule);
          if (actual !== null) {
            if (predicted === null) bucket.missedExhaustions++;
            else {
              bucket.errors.push((predicted - actual) / HOUR);
              if (gap !== null) bucket.gaps.push(gap);
            }
          } else if (lasted) {
            if (predicted !== null) bucket.falseAlarms++;
          } else bucket.censored++;
        }
      }
  }
  const scores = [...buckets.values()].map(({ errors, gaps, ...bucket }) => ({
    ...bucket,
    timedPredictions: errors.length,
    medianErrorHours: median(errors),
    medianAbsoluteErrorHours: median(errors.map(Math.abs)),
    medianObservationGapHours: median(gaps),
  }));
  const lengths = readings
    .map(duration)
    .filter((length): length is number => length !== null && length > 0);
  const longest = lengths.length ? Math.max(...lengths) : 7 * DAY;
  // Two complete periods, allowing one partial period when recording starts.
  const span = readings.length
    ? Math.max(0, now - Math.min(...readings.map((row) => Date.parse(row.checkedAt))))
    : 0;
  const estimatedMoreDays = Math.max(0, Math.ceil((3 * longest - span) / DAY));
  return {
    recordedReadings: readings.length,
    finishedWindows: finished.length,
    estimatedMoreDays,
    scores,
  };
}

function main() {
  const filePath = process.argv[2];
  if (!filePath)
    throw new Error(
      "Usage: node apps/server/scripts/usage-limit-backtest.ts <usage-limit-readings.ndjson> [--json]",
    );
  if (
    NodeFS.existsSync(filePath) &&
    NodeFS.statSync(filePath).size > USAGE_LIMIT_RECORDING_MAX_BYTES
  )
    throw new Error("Archive exceeds the 2 MiB recorder cap.");
  const readings = NodeFS.existsSync(filePath)
    ? readUsageLimitRecordings(NodeFS.readFileSync(filePath, "utf8"))
    : [];
  const report = backtestUsageLimits(readings, Date.now());
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`${report.recordedReadings} readings; ${report.finishedWindows} finished windows.`);
  console.log(
    "Checkpoints: percent used and percent elapsed. Errors: predicted minus first observed exhaustion, in hours.",
  );
  console.log(
    "driver | axis | % | rule | timed | median error h | median absolute h | observation gap h | false alarms | missed | censored",
  );
  for (const score of report.scores)
    console.log(
      [
        score.driver,
        score.axis,
        score.checkpoint,
        score.rule,
        score.timedPredictions,
        score.medianErrorHours?.toFixed(2) ?? "n/a",
        score.medianAbsoluteErrorHours?.toFixed(2) ?? "n/a",
        score.medianObservationGapHours?.toFixed(2) ?? "n/a",
        score.falseAlarms,
        score.missedExhaustions,
        score.censored,
      ].join(" | "),
    );
  if (report.finishedWindows < 2)
    console.log(
      `Allow about ${report.estimatedMoreDays} more days to observe two complete periods at the longest recorded duration (weekly by default). Exact timing errors also require observed exhaustion; byte-cap eviction or sparse use can take longer.`,
    );
  console.log(
    "Compare rules on the same checkpoints, including misses and false alarms. Small or sparse samples do not justify changing the forecast.",
  );
}

if (process.argv[1] && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url))
  main();
