import type { AutoModelFeedback, ModelSelection, ServerProvider } from "@t3tools/contracts";
import type { TaskDifficulty } from "@t3tools/shared/autoModel/classifyTaskDifficulty";
import type {
  AutoModelCandidate,
  AutoModelRecommendation,
  AutoModelSelection,
} from "@t3tools/shared/autoModel/recommendAutoModel";
import type { ModelBenchmarkTable } from "@t3tools/shared/modelBenchmarks";
import { canRunWork, limitsFromProviders } from "@t3tools/shared/modelPickEvidence";
import {
  benchmarkFor,
  limitWindowApplies,
  normalizeModelId,
  type ModelPicks,
} from "@t3tools/shared/modelPicks";
import { modelFamilySupersessions, modelRankingSelectionKey } from "@t3tools/shared/modelRankings";

import type { ModelOption } from "../../lib/modelOptions";

/** One new-chat draft's suggestion and what the user did with it. */
export interface AutoModelDraftState {
  readonly difficulty: TaskDifficulty | null;
  readonly recommendation: AutoModelRecommendation | null;
  readonly shown: boolean;
  readonly accepted: boolean;
  readonly dismissed: boolean;
}

export const EMPTY_AUTO_MODEL_DRAFT: AutoModelDraftState = {
  difficulty: null,
  recommendation: null,
  shown: false,
  accepted: false,
  dismissed: false,
};

/**
 * A model picked by hand in a new chat ends Auto there only once Auto has judged the prompt.
 * Picked before that (a harness or effort chosen before typing), it is simply the model the
 * prompt is judged against, so Auto still suggests when the task wants the other kind.
 */
export function autoModelAfterManualPick(state: AutoModelDraftState): AutoModelDraftState {
  return state.difficulty === null || state.dismissed ? state : { ...state, dismissed: true };
}

/**
 * Only an untouched first prompt is judged: a model picked after Auto judged
 * the prompt (or a suggestion taken or waved off) settles the draft's model.
 */
export function autoModelCanEvaluate(input: {
  readonly enabled: boolean;
  readonly manualSelection: boolean;
  readonly busy: boolean;
  readonly state: AutoModelDraftState;
}): boolean {
  return (
    input.enabled &&
    !input.manualSelection &&
    !input.busy &&
    !input.state.dismissed &&
    !input.state.accepted
  );
}

const selectionKey = (selection: AutoModelSelection | null | undefined) =>
  selection
    ? JSON.stringify([selection.instanceId, selection.model, selection.options ?? []])
    : null;

export function sameAutoModelRecommendation(
  a: AutoModelRecommendation | null,
  b: AutoModelRecommendation | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.tier === b.tier &&
    a.label === b.label &&
    selectionKey(a.selection) === selectionKey(b.selection)
  );
}

/**
 * Folds a fresh evaluation into the draft. Returns the same object when nothing
 * changed, so callers can skip the write, and keeps `shown` for a suggestion the
 * user has already seen.
 */
export function mergeAutoModelEvaluation(
  state: AutoModelDraftState,
  difficulty: TaskDifficulty | null,
  recommendation: AutoModelRecommendation | null,
): AutoModelDraftState {
  const sameDifficulty =
    state.difficulty === difficulty ||
    (state.difficulty !== null &&
      difficulty !== null &&
      state.difficulty.tier === difficulty.tier &&
      state.difficulty.confidence === difficulty.confidence);
  const sameRecommendation = sameAutoModelRecommendation(state.recommendation, recommendation);
  if (sameDifficulty && sameRecommendation) return state;
  return {
    ...state,
    difficulty,
    recommendation: sameRecommendation ? state.recommendation : recommendation,
    shown: sameRecommendation ? state.shown : false,
  };
}

/** The first-send record, in the same shape web sends. Never carries the prompt. */
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

/** Joins the cached picks' quality with the environment's current catalog and limits. */
export function autoModelCandidates(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly options: ReadonlyArray<ModelOption>;
  readonly picks: ModelPicks;
  readonly table: ModelBenchmarkTable;
  readonly now: number;
}): AutoModelCandidate[] {
  const superseded = modelFamilySupersessions(input.providers);
  const limits = limitsFromProviders(input.providers);
  const providers = new Map(input.providers.map((provider) => [provider.instanceId, provider]));
  const scores = new Map(
    input.picks.candidates.map((candidate) => [candidate.key, candidate.quality]),
  );
  return input.options.flatMap((option): AutoModelCandidate[] => {
    const provider = providers.get(option.selection.instanceId);
    if (!provider) return [];
    const slug = option.selection.model;
    const benchmark = benchmarkFor(slug, input.table);
    const key = normalizeModelId(benchmark?.id ?? slug);
    const quality = scores.get(key);
    if (quality === undefined) return [];
    const windows = limits.filter(
      (window) =>
        window.instanceId === provider.instanceId &&
        (window.resetsAtMs === undefined || window.resetsAtMs > input.now) &&
        limitWindowApplies(window.id, slug, window),
    );
    const remainingPercent = Math.min(
      100,
      ...windows.map((window) => (window.limited ? 0 : 100 - window.usedPercent)),
    );
    const selection = { instanceId: provider.instanceId, model: slug };
    return [
      {
        selection,
        key,
        label: option.label,
        quality,
        available: canRunWork(provider) && option.isUnavailable !== true,
        disabled: option.isHidden === true,
        legacy: option.isLegacy,
        superseded: superseded.has(modelRankingSelectionKey(selection)),
        remainingPercent,
      },
    ];
  });
}

/** The picks' winners as selections, the fallbacks when chat history names no favorite. */
export function autoModelFallbacks(picks: ModelPicks | null): {
  readonly quality: AutoModelSelection | null;
  readonly speed: AutoModelSelection | null;
  readonly frugal: AutoModelSelection | null;
} {
  const selection = (kind: "quality" | "speed" | "frugal"): AutoModelSelection | null => {
    const route = picks?.picks[kind].winner?.route;
    return route?.instanceId ? { instanceId: route.instanceId, model: route.model } : null;
  };
  return { quality: selection("quality"), speed: selection("speed"), frugal: selection("frugal") };
}

/**
 * A cheap fingerprint of the evidence: it changes when evidence arrives or the
 * winners move, not when an unrelated update rebuilds the same arrays.
 */
export function autoModelEvidenceKey(
  candidates: ReadonlyArray<AutoModelCandidate>,
  picks: ModelPicks | null,
): string {
  const fallbacks = autoModelFallbacks(picks);
  return [
    candidates.length,
    selectionKey(fallbacks.quality),
    selectionKey(fallbacks.speed),
    selectionKey(fallbacks.frugal),
  ].join("|");
}

export function autoModelSuggestionText(recommendation: AutoModelRecommendation): string {
  return `${recommendation.tier === "fast" ? "Simple task" : "Needs more power"} · use ${recommendation.label}`;
}
