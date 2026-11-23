import {
  NodeId,
  ProviderInstanceId,
  SUBAGENT_GRADE_MAX,
  SubagentGrade,
  SubagentTaskKind,
  SubagentThumb,
  type SubagentRankingsSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const RecordedGrade = Schema.Struct({
  ...SubagentGrade.fields,
  grader: Schema.optionalKey(
    Schema.Struct({ instanceId: ProviderInstanceId, family: Schema.String }),
  ),
});
export type RecordedGrade = typeof RecordedGrade.Type;

export const RunRecord = Schema.Struct({
  taskId: NodeId,
  instanceId: ProviderInstanceId,
  model: Schema.String,
  family: Schema.String,
  kind: SubagentTaskKind,
  outcome: Schema.Literals(["completed", "failed", "cancelled", "interrupted"]),
  elapsedMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  fixRounds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  finishedAt: Schema.Number,
  grade: Schema.optionalKey(RecordedGrade),
  thumb: Schema.optionalKey(SubagentThumb),
});
export type RunRecord = typeof RunRecord.Type;
export const RankingsState = Schema.Struct({
  // Version 1 stored grades on a 1–5 scale; version 2 uses 1–10.
  version: Schema.Literals([1, 2]),
  runs: Schema.Array(RunRecord),
  pendingGrades: Schema.optionalKey(
    Schema.Array(Schema.Struct({ taskId: NodeId, ...RecordedGrade.fields })),
  ),
});
export type RankingsState = typeof RankingsState.Type;

/** Maps a version-1 grade onto 1–10, keeping both ends: 1, 3, 6, 8, 10. */
export function upgradeV1Grade(score: number): number {
  return Math.round(1 + (score - 1) * 2.25);
}

/** Current-version runs; a version-1 file's grades move onto the 1–10 scale. */
export function currentRuns(state: RankingsState): ReadonlyArray<RunRecord> {
  if (state.version === 2) return state.runs;
  return state.runs.map((run) =>
    run.grade === undefined
      ? run
      : { ...run, grade: { ...run.grade, score: upgradeV1Grade(run.grade.score) } },
  );
}
export const MAX_RUNS = 3000;
export const WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

export function retainRuns(runs: ReadonlyArray<RunRecord>): ReadonlyArray<RunRecord> {
  return runs
    .toSorted((a, b) => b.finishedAt - a.finishedAt || a.taskId.localeCompare(b.taskId))
    .slice(0, MAX_RUNS);
}

export function inferTaskKind(title: string, isolated: boolean): SubagentTaskKind {
  if (/\b(review|reviewer|audit)\b/i.test(title)) return "review";
  if (/\b(research|researcher|investigate|investigation)\b/i.test(title)) return "research";
  if (/\b(ui|ux|design|designer|frontend|front.end|web|mobile)\b/i.test(title)) return "ui";
  if (
    isolated ||
    /\b(code|coding|implementation|implement|fix|test|tests|backend|server)\b/i.test(title)
  )
    return "code";
  return "other";
}

/** Weighted score: one user thumb has four times the weight of a parent grade. */
function score(runs: ReadonlyArray<RunRecord>): {
  readonly average: number;
  readonly rated: number;
} {
  let weight = 0;
  let total = 0;
  let rated = 0;
  for (const run of runs) {
    if (run.grade) {
      total += run.grade.score;
      weight++;
    }
    if (run.thumb) {
      total += (run.thumb === "up" ? SUBAGENT_GRADE_MAX : 1) * 4;
      weight += 4;
    }
    if (run.grade || run.thumb) rated++;
  }
  return { average: weight ? total / weight : Number.NaN, rated };
}

function summary(runs: ReadonlyArray<RunRecord>): string {
  const n = runs.length;
  // Cancelled and interrupted runs were stopped from outside (the lead, the user or a restart),
  // so only runs that ended on their own say whether the model gets work done.
  const ended = runs.filter((r) => r.outcome === "completed" || r.outcome === "failed");
  const done = ended.length
    ? ` · ${Math.round((100 * ended.filter((r) => r.outcome === "completed").length) / ended.length)}% done`
    : "";
  const durations = runs.map((r) => r.elapsedMs).toSorted((a, b) => a - b);
  const mid = Math.floor(n / 2);
  const median = n % 2 ? durations[mid]! : (durations[mid - 1]! + durations[mid]!) / 2;
  const { average, rated } = score(runs);
  const graded = runs.filter((run) => run.grade !== undefined);
  const low = graded.filter((run) => run.grade!.score <= 6).length;
  return `${n} ${n === 1 ? "run" : "runs"}, ${rated} rated${done}${Number.isNaN(average) ? "" : ` · ${average.toFixed(1)}/${SUBAGENT_GRADE_MAX}`}${low ? ` · low grades ${low}/${graded.length}` : ""} · ${median < 30_000 ? `${Math.max(1, Math.round(median / 1000))}s` : `${Math.round(median / 60000)}m`} median${rated < 3 ? " · few runs" : ""}`;
}

function stats(runs: ReadonlyArray<RunRecord>) {
  const { average, rated } = score(runs);
  return {
    runs: runs.length,
    rated,
    ...(Number.isNaN(average) ? {} : { average }),
    completed: runs.filter((run) => run.outcome === "completed").length,
  };
}

const TASK_KINDS = ["code", "ui", "review", "research", "other"] as const;

/**
 * Kinds of task this model does clearly better or worse at than its own average (3+ rated
 * runs, a point or more apart), so a lead choosing a model for that kind sees it in the one
 * line it reads. Naming only the worse kinds made a model that reviews well and researches
 * badly look bad at everything.
 */
function kindNotes(runs: ReadonlyArray<RunRecord>): string {
  const overall = score(runs).average;
  if (Number.isNaN(overall)) return "";
  return TASK_KINDS.flatMap((kind) => {
    const { average, rated } = score(runs.filter((r) => r.kind === kind));
    return rated >= 3 && Math.abs(average - overall) >= 1
      ? [` · ${kind} ${average.toFixed(1)}/${SUBAGENT_GRADE_MAX}`]
      : [];
  }).join("");
}

export function rankingsSnapshot(
  runs: ReadonlyArray<RunRecord>,
  now: number,
  assignmentGrades: NonNullable<RankingsState["pendingGrades"]> = [],
): SubagentRankingsSnapshot {
  const groups = new Map<string, Array<RunRecord>>();
  for (const run of runs) {
    if (run.finishedAt < now - WINDOW_MS || run.finishedAt > now) continue;
    const key = `${run.instanceId}\0${run.model}`;
    const group = groups.get(key);
    if (group) group.push(run);
    else groups.set(key, [run]);
  }
  return {
    models: [...groups.values()]
      .map((all) => {
        const active = all;
        const first = all[0]!;
        return {
          instanceId: first.instanceId,
          model: first.model,
          family: first.family,
          yourRuns: summary(active) + kindNotes(active),
          stats: stats(active),
          byKind: TASK_KINDS.flatMap((kind) => {
            const matching = active.filter((r) => r.kind === kind);
            return matching.length ? [{ kind, yourRuns: summary(matching) }] : [];
          }),
        };
      })
      .toSorted(
        (a, b) => a.instanceId.localeCompare(b.instanceId) || a.model.localeCompare(b.model),
      ),
    // Follow-up assignments have cards of their own but share the original model run.
    thumbs: [
      ...runs.map(({ taskId, thumb, grade }) => ({
        taskId,
        ...(thumb === undefined ? {} : { thumb }),
        ...(grade === undefined ? {} : { grade: grade.score }),
      })),
      ...assignmentGrades.map(({ taskId, score }) => ({ taskId, grade: score })),
    ],
  };
}
