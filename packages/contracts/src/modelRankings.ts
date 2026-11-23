import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ProviderOptionSelection } from "./model.ts";
import { ModelSelection } from "./modelSelection.ts";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

const RankingId = TrimmedNonEmptyString.check(Schema.isMaxLength(120));
export const ModelRankingTier = Schema.Literals(["S", "A", "B", "C", "D", "F"]);
export type ModelRankingTier = typeof ModelRankingTier.Type;

export const ModelFamilyId = TrimmedNonEmptyString.check(Schema.isMaxLength(120));
export type ModelFamilyId = typeof ModelFamilyId.Type;

export const LegacyModelRankingEntry = Schema.Struct({
  id: RankingId,
  selection: ModelSelection,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  tier: Schema.optionalKey(ModelRankingTier),
  note: Schema.optionalKey(TrimmedString.check(Schema.isMaxLength(500))),
});
export type LegacyModelRankingEntry = typeof LegacyModelRankingEntry.Type;

export const ModelFamilyRankingEntry = Schema.Struct({
  id: RankingId,
  family: ModelFamilyId,
  /** Active source membership while an opaque provider family awaits catalog metadata. */
  pendingLegacyIds: Schema.optionalKey(Schema.Array(RankingId).check(Schema.isMaxLength(100))),
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  tier: Schema.optionalKey(ModelRankingTier),
  note: Schema.optionalKey(TrimmedString.check(Schema.isMaxLength(500))),
});
export type ModelFamilyRankingEntry = typeof ModelFamilyRankingEntry.Type;

/** Keep old settings readable until the environment migrates them to families. */
export const ModelRankingEntry = Schema.Union([ModelFamilyRankingEntry, LegacyModelRankingEntry]);
export type ModelRankingEntry = typeof ModelRankingEntry.Type;

export const ModelRankingCategory = Schema.Struct({
  id: RankingId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  entries: Schema.Array(ModelRankingEntry).check(Schema.isMaxLength(100)),
  /** Explicit preference order; entries absent here are unranked. */
  order: Schema.Array(RankingId).check(Schema.isMaxLength(100)),
  /** Original individual-model choices, retained so collapsing a family never loses data. */
  legacy: Schema.optionalKey(
    Schema.Struct({
      entries: Schema.Array(LegacyModelRankingEntry),
      /** Active family edits retained when provisional identities later merge. */
      families: Schema.optionalKey(Schema.Array(ModelFamilyRankingEntry)),
      order: Schema.Array(RankingId),
      comparisons: Schema.Array(
        Schema.Struct({
          left: RankingId,
          right: RankingId,
          result: Schema.Literals(["left", "right", "skip"]),
        }),
      ),
    }),
  ),
  comparisons: Schema.Array(
    Schema.Struct({
      left: RankingId,
      right: RankingId,
      result: Schema.Literals(["left", "right", "skip"]),
    }),
  ).check(Schema.isMaxLength(4_950)),
});
export type ModelRankingCategory = typeof ModelRankingCategory.Type;

/** Empty means no user preferences, including for built-in categories. */
export const ModelRankings = Schema.Array(ModelRankingCategory).check(Schema.isMaxLength(30));
export type ModelRankings = typeof ModelRankings.Type;

export class ModelRankingsSaveError extends Schema.TaggedError<ModelRankingsSaveError>()(
  "ModelRankingsSaveError",
  { reason: Schema.Literals(["conflict", "base-required", "unsupported"]) },
) {
  override get message(): string {
    switch (this.reason) {
      case "conflict":
        return "Model family rankings changed on another client. Your edits are kept. Discard unsaved changes to load the saved rankings, then reapply your edits.";
      case "base-required":
        return "This client must supply the saved model family rankings before editing. Reload or update the client and try again.";
      case "unsupported":
        return "Update this environment to save model family rankings safely across clients.";
    }
  }
}

export const ModelPreferencesQuery = Schema.Struct({
  task: TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }))),
});
export type ModelPreferencesQuery = typeof ModelPreferencesQuery.Type;

export const ModelPreferencesResult = Schema.Struct({
  matchedCategory: Schema.NullOr(Schema.Struct({ id: RankingId, name: Schema.String })),
  recommendations: Schema.Array(
    Schema.Struct({
      family: Schema.optionalKey(ModelFamilyId),
      providerInstanceId: ProviderInstanceId,
      model: Schema.String,
      options: Schema.optionalKey(Schema.Array(ProviderOptionSelection)),
      tier: Schema.optionalKey(ModelRankingTier),
      note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(180))),
    }),
  ).check(Schema.isMaxLength(5)),
  unavailableCount: Schema.Int,
  notes: Schema.Array(Schema.String).check(Schema.isMaxLength(4)),
});
export type ModelPreferencesResult = typeof ModelPreferencesResult.Type;
