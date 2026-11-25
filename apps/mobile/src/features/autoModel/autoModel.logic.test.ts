import type { AutoModelRecommendation } from "@t3tools/shared/autoModel/recommendAutoModel";
import { describe, expect, it } from "vite-plus/test";

import {
  autoModelAfterManualPick,
  autoModelCanEvaluate,
  autoModelEvidenceKey,
  autoModelOutcome,
  autoModelSuggestionText,
  EMPTY_AUTO_MODEL_DRAFT,
  mergeAutoModelEvaluation,
} from "./autoModel.logic";

const quick: AutoModelRecommendation = {
  tier: "fast",
  confidence: 0.9,
  selection: { instanceId: "claude", model: "claude-haiku-5-5" },
  label: "Haiku 5.5",
};

describe("mergeAutoModelEvaluation", () => {
  it("returns the same state when the result has not changed", () => {
    const first = mergeAutoModelEvaluation(
      EMPTY_AUTO_MODEL_DRAFT,
      { tier: "fast", confidence: 0.9 },
      quick,
    );
    const again = mergeAutoModelEvaluation(
      first,
      { tier: "fast", confidence: 0.9 },
      { ...quick, selection: { ...quick.selection } },
    );
    expect(again).toBe(first);
    // Nothing to judge on an empty draft writes nothing either.
    expect(mergeAutoModelEvaluation(EMPTY_AUTO_MODEL_DRAFT, null, null)).toBe(
      EMPTY_AUTO_MODEL_DRAFT,
    );
  });

  it("keeps a seen suggestion seen while only the confidence moves", () => {
    const seen = {
      ...mergeAutoModelEvaluation(EMPTY_AUTO_MODEL_DRAFT, { tier: "fast", confidence: 0.9 }, quick),
      shown: true,
    };
    const next = mergeAutoModelEvaluation(
      seen,
      { tier: "fast", confidence: 0.95 },
      {
        ...quick,
        confidence: 0.95,
      },
    );
    expect(next.shown).toBe(true);
    expect(next.difficulty?.confidence).toBe(0.95);
    expect(next.recommendation).toBe(seen.recommendation);
  });

  it("treats a different model as a new, unseen suggestion", () => {
    const seen = { ...EMPTY_AUTO_MODEL_DRAFT, recommendation: quick, shown: true };
    const next = mergeAutoModelEvaluation(
      seen,
      { tier: "big", confidence: 0.9 },
      {
        tier: "big",
        confidence: 0.9,
        selection: { instanceId: "claude", model: "claude-fable-5-2" },
        label: "Fable 5.2",
      },
    );
    expect(next.shown).toBe(false);
    expect(next.recommendation?.label).toBe("Fable 5.2");
  });
});

describe("autoModelCanEvaluate", () => {
  const base = { enabled: true, manualSelection: false, busy: false };
  it("stops for a hand-picked model, a send, and once the suggestion is settled", () => {
    expect(autoModelCanEvaluate({ ...base, state: EMPTY_AUTO_MODEL_DRAFT })).toBe(true);
    expect(autoModelCanEvaluate({ ...base, enabled: false, state: EMPTY_AUTO_MODEL_DRAFT })).toBe(
      false,
    );
    expect(
      autoModelCanEvaluate({ ...base, manualSelection: true, state: EMPTY_AUTO_MODEL_DRAFT }),
    ).toBe(false);
    expect(autoModelCanEvaluate({ ...base, busy: true, state: EMPTY_AUTO_MODEL_DRAFT })).toBe(
      false,
    );
    expect(
      autoModelCanEvaluate({ ...base, state: { ...EMPTY_AUTO_MODEL_DRAFT, dismissed: true } }),
    ).toBe(false);
    expect(
      autoModelCanEvaluate({ ...base, state: { ...EMPTY_AUTO_MODEL_DRAFT, accepted: true } }),
    ).toBe(false);
  });
});

describe("autoModelOutcome", () => {
  it("records the tier, model and what the user did, never the prompt", () => {
    expect(autoModelOutcome(undefined)).toEqual({
      suggestedTier: null,
      confidence: null,
      suggestedModel: null,
      shown: false,
      accepted: false,
    });
    const outcome = autoModelOutcome({
      ...EMPTY_AUTO_MODEL_DRAFT,
      difficulty: { tier: "fast", confidence: 0.9 },
      recommendation: quick,
      shown: true,
      accepted: true,
    });
    expect(outcome).toEqual({
      suggestedTier: "fast",
      confidence: 0.9,
      suggestedModel: quick.selection,
      shown: true,
      accepted: true,
    });
  });
});

describe("autoModelEvidenceKey", () => {
  it("ignores new array identities and changes when evidence arrives", () => {
    expect(autoModelEvidenceKey([], null)).toBe(autoModelEvidenceKey([], null));
    const candidate = {
      selection: quick.selection,
      label: quick.label,
      quality: 50,
      available: true,
    };
    expect(autoModelEvidenceKey([candidate], null)).not.toBe(autoModelEvidenceKey([], null));
  });
});

it("words the suggestion like web", () => {
  expect(autoModelSuggestionText(quick)).toBe("Simple task · use Haiku 5.5");
  expect(autoModelSuggestionText({ ...quick, tier: "big", label: "Fable 5.2" })).toBe(
    "Needs more power · use Fable 5.2",
  );
});

it("keeps Auto evaluating when a model is picked before typing, and dismisses after judging", () => {
  const beforeTyping = autoModelAfterManualPick(EMPTY_AUTO_MODEL_DRAFT);
  expect(beforeTyping).toBe(EMPTY_AUTO_MODEL_DRAFT);
  expect(
    autoModelCanEvaluate({
      enabled: true,
      manualSelection: false,
      busy: false,
      state: beforeTyping,
    }),
  ).toBe(true);

  const judged = mergeAutoModelEvaluation(
    EMPTY_AUTO_MODEL_DRAFT,
    { tier: "fast", confidence: 0.9 },
    quick,
  );
  const afterJudged = autoModelAfterManualPick(judged);
  expect(afterJudged.dismissed).toBe(true);
  expect(
    autoModelCanEvaluate({
      enabled: true,
      manualSelection: false,
      busy: false,
      state: afterJudged,
    }),
  ).toBe(false);
});
