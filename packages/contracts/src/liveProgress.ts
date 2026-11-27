import * as Schema from "effect/Schema";

/** Settings > Agents token use High: what a working agent reports for its live progress card. */
export const LIVE_PROGRESS_STAGE_STATUSES = ["done", "active", "pending"] as const;
export const LiveProgressStageStatus = Schema.Literals(LIVE_PROGRESS_STAGE_STATUSES);
export type LiveProgressStageStatus = typeof LiveProgressStageStatus.Type;

export const LIVE_PROGRESS_TITLE_MAX = 60;
export const LIVE_PROGRESS_UPDATE_MAX = 140;
/** Updates kept per chat, newest first. */
export const LIVE_PROGRESS_UPDATES_KEPT = 5;
/** Stages kept from one report; later ones are dropped. */
export const LIVE_PROGRESS_STAGES_MAX = 12;

/**
 * `report_progress` input. Every field is optional so an update alone is one short call. Long
 * text is clipped and a percent clamped rather than refused, so a report never costs a retry.
 */
export const ReportProgressInput = Schema.Struct({
  stages: Schema.optional(
    Schema.Array(
      Schema.Struct({
        title: Schema.String,
        status: LiveProgressStageStatus,
        minutes: Schema.optional(Schema.Finite),
      }),
    ),
  ),
  update: Schema.optional(Schema.String),
  percent: Schema.optional(Schema.Finite),
});
export type ReportProgressInput = typeof ReportProgressInput.Type;

export const ReportProgressResult = Schema.Struct({ ok: Schema.Literal(true) });
export type ReportProgressResult = typeof ReportProgressResult.Type;

export const OrchestrationV2LiveProgressStage = Schema.Struct({
  title: Schema.String,
  status: LiveProgressStageStatus,
  /** The agent's rough estimate in minutes, before the app's calibration. */
  minutes: Schema.optional(Schema.Number),
  /** Active stages: when the app first saw it active, epoch ms. */
  startedAt: Schema.optional(Schema.Number),
  /** Done stages: how long it took, when the app saw it start. */
  durationMs: Schema.optional(Schema.Number),
});
export type OrchestrationV2LiveProgressStage = typeof OrchestrationV2LiveProgressStage.Type;

/**
 * A working chat's live progress while Settings > Agents token use is High: the agent's latest
 * `report_progress`, or its own todo list when it never reported. Times are epoch ms.
 */
export const OrchestrationV2LiveProgress = Schema.Struct({
  /** "todo" when the stages come from the agent's own todo or plan list. */
  source: Schema.Literals(["report", "todo"]),
  /** When the work started; a wake keeps the start of the work it continues. */
  startedAt: Schema.Number,
  reportedAt: Schema.Number,
  stages: Schema.Array(OrchestrationV2LiveProgressStage),
  /** Newest first, at most five. */
  updates: Schema.Array(Schema.Struct({ text: Schema.String, at: Schema.Number })),
  percent: Schema.optional(Schema.Number),
  /**
   * How this model's past minute estimates compared with the time stages really took
   * (actual ÷ estimated). Absent means no history yet (1).
   */
  pace: Schema.optional(Schema.Number),
  /** Expected finish as of the last report, when there is an estimate. */
  etaAt: Schema.optional(Schema.Number),
});
export type OrchestrationV2LiveProgress = typeof OrchestrationV2LiveProgress.Type;
