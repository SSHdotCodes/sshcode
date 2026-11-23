import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * What Auto asks an outside decision model about a new chat's first message.
 *
 * Measured 2026-11-13 on 133 of the owner's labelled first messages plus a dozen
 * phrasing checks, ten decision models that offer zero data retention, each asked
 * with both option orders. Alone, the best of them rank the messages about as well
 * as the model on this machine (which has learned the owner's habits) and far better
 * on phrasing it has never seen ("build a black hole simulation"). Averaged with the
 * local model they beat both. The first model below gave the best average and never
 * changed its answer with the option order; the second was the best alone.
 * A longer rubric made every model worse, so the question stays this short.
 */
export const AUTO_MODEL_DECISION_URL = "https://openrouter.ai/api/alpha/decisions";
/** Tried in order; a model that fails rests for a while and the next one answers. */
export const AUTO_MODEL_DECISION_MODELS = [
  "perplexity/pplx-decider-v1.3:free",
  "liquid/d1-ultra",
] as const;
export const AUTO_MODEL_DECISION_TEXT_LIMIT = 2500;

const INSTRUCTIONS =
  "A developer sends this first message to an AI coding agent that works in his code repositories and on his machines. " +
  "Decide how much model capability the request needs. Judge the work the request implies, not its length: a short request " +
  'can be hard ("make the app faster") and a long one can be simple. If the message asks for several things, judge by the ' +
  "hardest one. Attached images or files usually mean a UI bug or a review.";
const QUICK =
  "A small, fast model does this well: a status, yes/no or factual question, a web lookup, run or show something, a rename, " +
  "a typo, a one-line or config change, commit or push, a small fully specified change in one place, a short explanation. " +
  "No design choice and no debugging.";
const POWER =
  "Needs a top model: building an app, game, simulation or feature, several steps or files, debugging, a refactor, a review, " +
  "design or product decisions, performance work, research across sources, ML training, long autonomous work.";

export function autoModelDecisionRequest(model: string, text: string, attachmentCount: number) {
  return {
    model,
    state: `Attachments: ${attachmentCount}\nMessage:\n${text.slice(0, AUTO_MODEL_DECISION_TEXT_LIMIT)}`,
    questions: {
      need: {
        type: "choice",
        instructions: INSTRUCTIONS,
        criteria: { quick: QUICK, power: POWER },
      },
    },
    // Zero data retention or no answer at all: without such an endpoint the request fails,
    // and nothing here ever retries it with a weaker promise.
    provider: { zdr: true, data_collection: "deny" },
  } as const;
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
/** The request as the body to post. */
export const autoModelDecisionBody = (model: string, text: string, attachmentCount: number) =>
  encodeJson(autoModelDecisionRequest(model, text, attachmentCount));

const Reply = Schema.Struct({
  answers: Schema.Struct({
    need: Schema.Struct({
      choice: Schema.optional(Schema.String),
      probabilities: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
    }),
  }),
});
const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(Reply));

/** The reply's probability, 0 to 1, that a quick model is enough. */
export function autoModelDecisionQuick(body: string): number | undefined {
  const need = Option.getOrUndefined(decodeReply(body))?.answers.need;
  if (need === undefined) return undefined;
  const quick = need.probabilities?.["quick"];
  if (quick !== undefined) {
    return Number.isFinite(quick) ? Math.min(Math.max(quick, 0), 1) : undefined;
  }
  // A model that only names its choice counts as fairly sure of it.
  return need.choice === "quick" ? 0.9 : need.choice === "power" ? 0.1 : undefined;
}
