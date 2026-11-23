import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import { classifyTaskDifficulty } from "@t3tools/shared/autoModel/classifyTaskDifficulty";
import {
  recommendAutoModel,
  type AutoModelCandidate,
  type AutoModelRecommendation,
} from "@t3tools/shared/autoModel/recommendAutoModel";
import type { ModelPicks } from "@t3tools/shared/modelPicks";
import { useEffect, useRef } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { withRememberedModelOptions } from "../../state/use-model-option-memory";
import { autoModelFallbacks, mergeAutoModelEvaluation } from "./autoModel.logic";
import { updateAutoModelDraft } from "./autoModelDraftState";

export const AUTO_MODEL_DEBOUNCE_MS = 400;

/** Everything the evaluation reads when it fires; kept in a ref so it never restarts the timer. */
export interface AutoModelEvaluationInputs {
  readonly environmentId: EnvironmentId;
  readonly currentSelection: ModelSelection;
  readonly candidates: ReadonlyArray<AutoModelCandidate>;
  readonly picks: ModelPicks | null;
}

/** A decision model answers in about 0.3s; after this the local model's word is shown. */
const DECISION_WAIT_MS = 1500;
/** What the server sends on; longer drafts are judged by their start. */
const DECISION_TEXT_LIMIT = 2500;
/** After "no answer" (switched off, no key, an older server) the server is left alone this long. */
const DECISION_RETRY_MS = 60_000;
const decisionRestsUntil = new Map<EnvironmentId, number>();

/**
 * Judges the prompt once typing pauses. The timer restarts only for the prompt,
 * attachment count, selected model, or evidence arriving: other chats updating
 * must not keep pushing it back.
 *
 * The server's decision model is asked first and its answer is combined with the
 * local model's. No answer in time, or none at all, and the local model decides
 * alone; a late answer still corrects the suggestion while the draft is unchanged.
 */
export function useAutoModelEvaluation(input: {
  readonly draftKey: string;
  readonly enabled: boolean;
  readonly text: string;
  readonly attachmentCount: number;
  readonly selectionKey: string;
  readonly evidenceKey: string;
  readonly latest: AutoModelEvaluationInputs;
}) {
  const latestRef = useRef(input.latest);
  useEffect(() => {
    latestRef.current = input.latest;
  });
  const askDecisionModel = useAtomCommand(serverEnvironment.decideAutoModelTask, {
    reportFailure: false,
    reportDefect: false,
  });
  const askRef = useRef(askDecisionModel);
  useEffect(() => {
    askRef.current = askDecisionModel;
  });
  const { draftKey, enabled, text, attachmentCount, selectionKey, evidenceKey } = input;
  useEffect(() => {
    if (!enabled) return;
    let stale = false;
    let waiting: ReturnType<typeof setTimeout> | undefined;
    const evaluate = (decisionQuick?: number) => {
      const { environmentId, currentSelection, candidates, picks } = latestRef.current;
      const difficulty = classifyTaskDifficulty({ text, attachmentCount, decisionQuick });
      // The chat list is read here, not subscribed: busy chats elsewhere must not re-render typing.
      const history = appAtomRegistry
        .get(environmentThreadShells.threadShellsAtom)
        .flatMap((chat) =>
          chat.environmentId === environmentId
            ? [
                {
                  createdBy: chat.source.createdBy,
                  createdAt: Date.parse(chat.createdAt),
                  modelSelection: chat.modelSelection,
                },
              ]
            : [],
        );
      const fallbacks = autoModelFallbacks(picks);
      const remember = (selection: typeof fallbacks.quality) =>
        selection ? withRememberedModelOptions(selection) : null;
      const recommendation: AutoModelRecommendation | null = recommendAutoModel({
        difficulty,
        text,
        attachmentCount,
        currentSelection,
        candidates,
        history,
        picks: {
          quality: remember(fallbacks.quality),
          speed: remember(fallbacks.speed),
          frugal: remember(fallbacks.frugal),
        },
        now: Date.now(),
      });
      updateAutoModelDraft(draftKey, (state) =>
        mergeAutoModelEvaluation(state, difficulty, recommendation),
      );
    };
    const timer = setTimeout(() => {
      if (text.trim().length < 12 && attachmentCount === 0) {
        updateAutoModelDraft(draftKey, (state) => mergeAutoModelEvaluation(state, null, null));
        return;
      }
      const { environmentId } = latestRef.current;
      if (Date.now() < (decisionRestsUntil.get(environmentId) ?? 0)) {
        evaluate();
        return;
      }
      let shown = false;
      waiting = setTimeout(() => {
        shown = true;
        evaluate();
      }, DECISION_WAIT_MS);
      void askRef
        .current({
          environmentId,
          input: { text: text.trim().slice(0, DECISION_TEXT_LIMIT), attachmentCount },
        })
        .then(
          (result) => (result._tag === "Success" ? (result.value?.quick ?? null) : null),
          () => null,
        )
        .then((quick) => {
          if (quick === null) decisionRestsUntil.set(environmentId, Date.now() + DECISION_RETRY_MS);
          if (stale) return;
          clearTimeout(waiting);
          if (quick !== null) evaluate(quick);
          else if (!shown) evaluate();
        });
    }, AUTO_MODEL_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
      clearTimeout(waiting);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- The selection and evidence keys restart the timer; their values are read from the ref.
  }, [draftKey, enabled, text, attachmentCount, selectionKey, evidenceKey]);
}
