import type { AutoModelFeedback, ModelSelection, ServerProvider } from "@t3tools/contracts";
import type { TaskDifficulty } from "@t3tools/shared/autoModel/classifyTaskDifficulty";
import type {
  AutoModelCandidate,
  AutoModelRecommendation,
} from "@t3tools/shared/autoModel/recommendAutoModel";
import {
  benchmarkFor,
  limitWindowApplies,
  normalizeModelId,
  type ModelPicks,
} from "@t3tools/shared/modelPicks";
import { canRunWork, limitsFromProviders } from "@t3tools/shared/modelPickEvidence";
import type { ModelBenchmarkTable } from "@t3tools/shared/modelBenchmarks";
import { modelFamilySupersessions, modelRankingSelectionKey } from "@t3tools/shared/modelRankings";
import type { ModelEsque } from "../components/chat/providerIconUtils";

export interface AutoModelDraftState {
  readonly difficulty: TaskDifficulty | null;
  readonly recommendation: AutoModelRecommendation | null;
  readonly shown: boolean;
  readonly accepted: boolean;
  readonly dismissed: boolean;
  readonly sent: boolean;
}

export const EMPTY_AUTO_MODEL_DRAFT: AutoModelDraftState = {
  difficulty: null,
  recommendation: null,
  shown: false,
  accepted: false,
  dismissed: false,
  sent: false,
};

export function cloneAutoModelDraft(state: AutoModelDraftState) {
  const { recommendation, ...rest } = state;
  const draft = { ...rest, difficulty: state.difficulty ? { ...state.difficulty } : null };
  if (recommendation === null) return { ...draft, recommendation: null };
  const { options, ...selection } = recommendation.selection;
  return {
    ...draft,
    recommendation: {
      ...recommendation,
      selection: {
        ...selection,
        ...(options ? { options: options.map((option) => ({ ...option })) } : {}),
      },
    },
  };
}

const sameRecommendation = (
  a: AutoModelRecommendation | null,
  b: AutoModelRecommendation | null,
): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.tier === b.tier &&
    a.label === b.label &&
    a.selection.instanceId === b.selection.instanceId &&
    a.selection.model === b.selection.model &&
    JSON.stringify(a.selection.options ?? null) === JSON.stringify(b.selection.options ?? null));

/**
 * Folds a fresh evaluation into the draft. Returns the same object when nothing changed, so
 * no store write follows, and keeps the shown suggestion (and that it was shown) while the
 * suggestion itself stays the same.
 */
export function mergeAutoModelEvaluation(
  previous: AutoModelDraftState,
  difficulty: TaskDifficulty | null,
  recommendation: AutoModelRecommendation | null,
): AutoModelDraftState {
  const kept = sameRecommendation(previous.recommendation, recommendation);
  if (
    kept &&
    previous.difficulty?.tier === difficulty?.tier &&
    previous.difficulty?.confidence === difficulty?.confidence
  )
    return previous;
  return {
    ...previous,
    difficulty,
    recommendation: kept ? previous.recommendation : recommendation,
    shown: kept ? previous.shown : false,
  };
}

/**
 * A model picked by hand in a new chat ends Auto there only once Auto has judged the prompt.
 * Picked before that (a harness or effort chosen before typing), it is simply the model the
 * prompt is judged against, so Auto still suggests when the task wants the other kind.
 */
export function autoModelAfterManualPick(state: AutoModelDraftState): AutoModelDraftState {
  return state.difficulty === null || state.dismissed ? state : { ...state, dismissed: true };
}

/**
 * Applied when a saved draft loads. A dismissal always follows a judged prompt; one without a
 * judgment is an early pick that older builds counted, and is dropped.
 */
export function reviveAutoModelDraft(state: AutoModelDraftState): AutoModelDraftState {
  return state.dismissed && state.difficulty === null ? { ...state, dismissed: false } : state;
}

export function autoModelCanEvaluate(input: {
  enabled: boolean;
  hasMessages: boolean;
  busy: boolean;
  state: AutoModelDraftState;
}): boolean {
  return (
    input.enabled &&
    !input.hasMessages &&
    !input.busy &&
    !input.state.sent &&
    !input.state.dismissed &&
    !input.state.accepted
  );
}

export function autoModelOutcome(
  state: AutoModelDraftState | undefined,
): Pick<
  AutoModelFeedback,
  "suggestedTier" | "confidence" | "suggestedModel" | "shown" | "accepted"
> {
  return {
    suggestedTier: state?.difficulty?.tier ?? null,
    confidence: state?.difficulty?.confidence ?? null,
    suggestedModel: state?.recommendation
      ? {
          ...state.recommendation.selection,
          instanceId: state.recommendation.selection.instanceId as ModelSelection["instanceId"],
        }
      : null,
    shown: state?.shown ?? false,
    accepted: state?.accepted ?? false,
  };
}

/** Joins the cached picks' quality with the destination's current catalog and model-scoped limits. */
export function autoModelCandidates(input: {
  providers: ReadonlyArray<ServerProvider>;
  models: ReadonlyMap<ModelSelection["instanceId"], ReadonlyArray<ModelEsque>>;
  picks: ModelPicks;
  table: ModelBenchmarkTable;
  now: number;
}): AutoModelCandidate[] {
  const superseded = modelFamilySupersessions(input.providers);
  const limits = limitsFromProviders(input.providers);
  const scores = new Map(
    input.picks.candidates.map((candidate) => [candidate.key, candidate.quality]),
  );
  return input.providers.flatMap((provider) =>
    (input.models.get(provider.instanceId) ?? []).flatMap((model): AutoModelCandidate[] => {
      const benchmark = benchmarkFor(model.slug, input.table);
      const quality = scores.get(normalizeModelId(benchmark?.id ?? model.slug));
      if (quality === undefined) return [];
      const windows = limits.filter(
        (window) =>
          window.instanceId === provider.instanceId &&
          (window.resetsAtMs === undefined || window.resetsAtMs > input.now) &&
          limitWindowApplies(window.id, model.slug, window),
      );
      const remainingPercent = Math.min(
        100,
        ...windows.map((window) => (window.limited ? 0 : 100 - window.usedPercent)),
      );
      const selection = { instanceId: provider.instanceId, model: model.slug };
      return [
        {
          selection,
          key: normalizeModelId(benchmark?.id ?? model.slug),
          label: model.shortName ?? model.name,
          quality,
          available: canRunWork(provider) && !model.isUnavailable,
          legacy: model.isLegacy === true,
          superseded:
            Boolean(model.supersededBy) || superseded.has(modelRankingSelectionKey(selection)),
          remainingPercent,
        },
      ];
    }),
  );
}
