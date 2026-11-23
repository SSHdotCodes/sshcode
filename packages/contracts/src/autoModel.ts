import * as Schema from "effect/Schema";
import { ThreadId, IsoDateTime } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/** First-message outcome only. Prompt contents never travel with this record. */
export const AutoModelFeedback = Schema.Struct({
  threadId: ThreadId,
  at: IsoDateTime,
  suggestedTier: Schema.NullOr(Schema.Literals(["fast", "big"])),
  confidence: Schema.NullOr(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  suggestedModel: Schema.NullOr(ModelSelection),
  shown: Schema.Boolean,
  accepted: Schema.Boolean,
  chosenModel: ModelSelection,
});
export type AutoModelFeedback = typeof AutoModelFeedback.Type;

/** A new chat's first message, for the decision model the server asks. Never stored. */
export const AutoModelDecisionInput = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(4000)),
  attachmentCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 })),
});
export type AutoModelDecisionInput = typeof AutoModelDecisionInput.Type;

/** How likely a quick model is enough for the message, 0 to 1, and which model said so. */
export const AutoModelDecision = Schema.Struct({
  quick: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  model: Schema.String,
});
export type AutoModelDecision = typeof AutoModelDecision.Type;
