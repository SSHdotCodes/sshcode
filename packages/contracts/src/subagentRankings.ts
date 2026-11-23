import * as Schema from "effect/Schema";
import { NodeId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** Grades run 1–10 (10 = right, no fixes needed); version-1 files held 1–5. */
export const SUBAGENT_GRADE_MAX = 10;

export const SubagentGrade = Schema.Struct({
  score: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: SUBAGENT_GRADE_MAX })),
  note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(80))),
});
export type SubagentGrade = typeof SubagentGrade.Type;

export const SubagentThumb = Schema.Literals(["up", "down"]);
export type SubagentThumb = typeof SubagentThumb.Type;

export const SubagentTaskKind = Schema.Literals(["code", "ui", "review", "research", "other"]);
export type SubagentTaskKind = typeof SubagentTaskKind.Type;

export const SubagentRankingsSnapshot = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      model: Schema.String,
      family: Schema.String,
      yourRuns: Schema.String,
      byKind: Schema.Array(Schema.Struct({ kind: SubagentTaskKind, yourRuns: Schema.String })),
      /** The figures behind `yourRuns`, for clients that compute with them. */
      stats: Schema.optionalKey(
        Schema.Struct({
          runs: Schema.Int,
          /** Runs with a lead's grade or the user's thumb. */
          rated: Schema.Int,
          /** Weighted mean on the 1–10 scale; absent without rated runs. */
          average: Schema.optionalKey(Schema.Number),
          completed: Schema.Int,
        }),
      ),
    }),
  ),
  /**
   * Every retained task is eligible for feedback, including those without a thumb yet.
   * `grade` is the lead's score for it; its note stays on the server.
   */
  thumbs: Schema.Array(
    Schema.Struct({
      taskId: NodeId,
      thumb: Schema.optionalKey(SubagentThumb),
      grade: Schema.optionalKey(SubagentGrade.fields.score),
    }),
  ),
});
export type SubagentRankingsSnapshot = typeof SubagentRankingsSnapshot.Type;

export const SubagentRankingsThumbInput = Schema.Struct({ taskId: NodeId, thumb: SubagentThumb });
export type SubagentRankingsThumbInput = typeof SubagentRankingsThumbInput.Type;

export class SubagentRankingsError extends Schema.TaggedError<SubagentRankingsError>()(
  "SubagentRankingsError",
  {
    operation: Schema.Literals(["read", "write", "grade", "thumb"]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}
