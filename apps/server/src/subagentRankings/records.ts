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

const TaskGrade = Schema.Struct({ taskId: NodeId, ...RecordedGrade.fields });

const Outcome = Schema.Literals(["completed", "failed", "cancelled", "interrupted"]);

/**
 * A follow-up assignment (t3_thread_send) continues its original run's child thread. It is
 * not a run of its own; its outcome, grade and thumb count inside the original run.
 * Outcome and finish time are missing for grades attached before its completion was recorded.
 */
export const FollowUp = Schema.Struct({
  taskId: NodeId,
  outcome: Schema.optionalKey(Outcome),
  finishedAt: Schema.optionalKey(Schema.Number),
  grade: Schema.optionalKey(RecordedGrade),
  thumb: Schema.optionalKey(SubagentThumb),
});
export type FollowUp = typeof FollowUp.Type;

export const RunRecord = Schema.Struct({
  taskId: NodeId,
  instanceId: ProviderInstanceId,
  model: Schema.String,
  family: Schema.String,
  kind: SubagentTaskKind,
  outcome: Outcome,
  elapsedMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  fixRounds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  finishedAt: Schema.Number,
  grade: Schema.optionalKey(RecordedGrade),
  followUps: Schema.optionalKey(Schema.Array(FollowUp)),
  thumb: Schema.optionalKey(SubagentThumb),
});
export type RunRecord = typeof RunRecord.Type;
export const RankingsState = Schema.Struct({
  // Version 1 stored grades on a 1–5 scale; version 2 uses 1–10.
  version: Schema.Literals([1, 2]),
  runs: Schema.Array(RunRecord),
  /**
   * Grades waiting for their run record: an original task's grade until its terminal record
   * lands, and grades from before follow-ups were attached until startup resolves them.
   * `runTaskId` names the original run a follow-up grade belongs to.
   */
  pendingGrades: Schema.optionalKey(
    Schema.Array(Schema.Struct({ ...TaskGrade.fields, runTaskId: Schema.optionalKey(NodeId) })),
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

/**
 * Leads flag only work that fell short since 11-25: 88% of earlier grades
 * were 8-10. A run that finished on its own after it and nobody graded counts as fine.
 */
export const FLAG_ONLY_GRADING_SINCE = Date.UTC(2026, 10, 25, 19);
/** About the mean of the earlier grades that weren't low (8.65), so averages stay comparable. */
const UNFLAGGED_SCORE = 8.5;

function countsAsUnflagged(turn: RunRecord | FollowUp): boolean {
  return (
    turn.grade === undefined &&
    turn.thumb === undefined &&
    turn.outcome === "completed" &&
    turn.finishedAt !== undefined &&
    turn.finishedAt >= FLAG_ONLY_GRADING_SINCE
  );
}

/** The run's own turn, then each follow-up assignment that continued it. */
function turns(run: RunRecord): ReadonlyArray<RunRecord | FollowUp> {
  return [run, ...(run.followUps ?? [])];
}

function parentGrades(run: RunRecord): ReadonlyArray<number> {
  return turns(run).flatMap((turn) => (turn.grade ? [turn.grade.score] : []));
}

/**
 * Weighted score: one user thumb has four times the weight of a parent grade. Each follow-up
 * is scored like the run's own turn, yet the run counts once in `rated`.
 */
function score(runs: ReadonlyArray<RunRecord>): {
  readonly average: number;
  readonly rated: number;
} {
  let weight = 0;
  let total = 0;
  let rated = 0;
  for (const run of runs) {
    const before = weight;
    for (const turn of turns(run)) {
      if (turn.grade) {
        total += turn.grade.score;
        weight++;
      } else if (countsAsUnflagged(turn)) {
        total += UNFLAGGED_SCORE;
        weight++;
      }
      if (turn.thumb) {
        total += (turn.thumb === "up" ? SUBAGENT_GRADE_MAX : 1) * 4;
        weight += 4;
      }
    }
    if (weight > before) rated++;
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
  const graded = runs.filter(
    (run) => parentGrades(run).length || turns(run).some(countsAsUnflagged),
  );
  const low = graded.filter((run) => parentGrades(run).some((grade) => grade <= 6)).length;
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
 * Kinds of task this model does clearly better or worse at (3+ rated runs, either a point
 * off its overall score or >=1.5 points off the other kinds when those have 3+ rated runs).
 * Comparing against the other kinds catches the dominant weak kind too (e.g. a model whose
 * majority-research runs drag its overall score down while its reviews score well).
 */
function kindNotes(runs: ReadonlyArray<RunRecord>): string {
  const overall = score(runs).average;
  if (Number.isNaN(overall)) return "";
  return TASK_KINDS.flatMap((kind) => {
    const { average, rated } = score(runs.filter((r) => r.kind === kind));
    if (rated < 3) return [];
    const other = score(runs.filter((r) => r.kind !== kind));
    const differsFromOverall = Math.abs(average - overall) >= 1;
    const differsFromOthers = other.rated >= 3 && Math.abs(average - other.average) >= 1.5;
    return differsFromOverall || differsFromOthers
      ? [` · ${kind} ${average.toFixed(1)}/${SUBAGENT_GRADE_MAX}`]
      : [];
  }).join("");
}

type PendingGrade = NonNullable<RankingsState["pendingGrades"]>[number];

/** Updates (or adds) one follow-up on its original run; a follow-up appears once. */
export function withFollowUp(
  run: RunRecord,
  taskId: NodeId,
  change: (followUp: FollowUp) => FollowUp,
): RunRecord {
  const followUps = run.followUps ?? [];
  const index = followUps.findIndex((followUp) => followUp.taskId === taskId);
  const next = change(index === -1 ? { taskId } : followUps[index]!);
  return {
    ...run,
    followUps:
      index === -1 ? [...followUps, next] : followUps.map((f, i) => (i === index ? next : f)),
  };
}

/**
 * Puts each grade on the run it was given for: the run itself, or for a follow-up the original
 * run its `runTaskId` names. A later grade for the same task replaces the earlier one.
 * Returns the grades whose run record is not (yet) retained.
 */
export function attachGrades(
  runs: ReadonlyArray<RunRecord>,
  grades: ReadonlyArray<PendingGrade>,
): { readonly runs: ReadonlyArray<RunRecord>; readonly unattached: ReadonlyArray<PendingGrade> } {
  const byRun = new Map<string, Array<PendingGrade>>();
  for (const grade of grades) {
    const key = grade.runTaskId ?? grade.taskId;
    const list = byRun.get(key);
    if (list) list.push(grade);
    else byRun.set(key, [grade]);
  }
  const attached = new Set<PendingGrade>();
  const next = runs.map((run) => {
    const incoming = byRun.get(run.taskId);
    if (incoming === undefined) return run;
    let result = run;
    for (const entry of incoming) {
      attached.add(entry);
      const { taskId, runTaskId, ...grade } = entry;
      result =
        runTaskId === undefined || runTaskId === taskId
          ? { ...result, grade }
          : withFollowUp(result, taskId, (followUp) => ({ ...followUp, grade }));
    }
    return result;
  });
  return { runs: next, unattached: grades.filter((grade) => !attached.has(grade)) };
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
      ...runs.flatMap((run) =>
        turns(run).flatMap(({ taskId, thumb, grade }) =>
          // A follow-up nobody rated has no card state to publish.
          taskId !== run.taskId && thumb === undefined && grade === undefined
            ? []
            : [
                {
                  taskId,
                  ...(thumb === undefined ? {} : { thumb }),
                  ...(grade === undefined ? {} : { grade: grade.score }),
                },
              ],
        ),
      ),
      ...assignmentGrades.map(({ taskId, score }) => ({ taskId, grade: score })),
    ],
  };
}
