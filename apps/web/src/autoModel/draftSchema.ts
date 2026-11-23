import * as Schema from "effect/Schema";
import { ProviderOptionSelection } from "@t3tools/contracts";

const difficulty = {
  tier: Schema.Literals(["fast", "big"]),
  confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
};

/** Optional draft metadata keeps dismissals and acceptance intact through a client restart. */
export const AutoModelDraftSchema = Schema.Struct({
  difficulty: Schema.NullOr(Schema.Struct(difficulty)),
  recommendation: Schema.NullOr(
    Schema.Struct({
      ...difficulty,
      label: Schema.String,
      selection: Schema.Struct({
        instanceId: Schema.String,
        model: Schema.String,
        options: Schema.optionalKey(Schema.Array(ProviderOptionSelection)),
      }),
    }),
  ),
  shown: Schema.Boolean,
  accepted: Schema.Boolean,
  dismissed: Schema.Boolean,
  sent: Schema.Boolean,
});
export const isAutoModelDraft = Schema.is(AutoModelDraftSchema);
