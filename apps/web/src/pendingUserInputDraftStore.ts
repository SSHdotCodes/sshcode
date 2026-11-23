import type { SetStateAction } from "react";
import { create } from "zustand";

import type { UserInputQuestion } from "@t3tools/contracts";
import { useComposerDraftStore, type ComposerThreadTarget } from "./composerDraftStore";
import {
  setPendingUserInputCustomAnswer,
  type PendingUserInputDraftAnswer,
} from "./pendingUserInput";

type AnswersByRequestKey = Record<string, Record<string, PendingUserInputDraftAnswer>>;
type QuestionIndexByRequestKey = Record<string, number>;

interface PendingUserInputDraftState {
  readonly answersByRequestKey: AnswersByRequestKey;
  readonly questionIndexByRequestKey: QuestionIndexByRequestKey;
  readonly setAnswersByRequestKey: (update: SetStateAction<AnswersByRequestKey>) => void;
  readonly setQuestionIndexByRequestKey: (
    update: SetStateAction<QuestionIndexByRequestKey>,
  ) => void;
  /** Drops an answered or dismissed card's draft. */
  readonly clearRequest: (requestKey: string) => void;
}

const apply = <T>(update: SetStateAction<T>, current: T): T =>
  typeof update === "function" ? (update as (previous: T) => T)(current) : update;

/**
 * Half-answered question cards, by request. The chat view remounts for every
 * chat, so answers kept in it vanished when the user switched to another chat
 * before finishing; here they last until the card is answered or dismissed.
 */
export const usePendingUserInputDraftStore = create<PendingUserInputDraftState>()((set) => ({
  answersByRequestKey: {},
  questionIndexByRequestKey: {},
  setAnswersByRequestKey: (update) =>
    set((state) => {
      const next = apply(update, state.answersByRequestKey);
      return next === state.answersByRequestKey ? state : { answersByRequestKey: next };
    }),
  setQuestionIndexByRequestKey: (update) =>
    set((state) => {
      const next = apply(update, state.questionIndexByRequestKey);
      return next === state.questionIndexByRequestKey ? state : { questionIndexByRequestKey: next };
    }),
  clearRequest: (requestKey) =>
    set((state) => {
      if (
        !(requestKey in state.answersByRequestKey) &&
        !(requestKey in state.questionIndexByRequestKey)
      )
        return state;
      const { [requestKey]: _answers, ...answersByRequestKey } = state.answersByRequestKey;
      const { [requestKey]: _index, ...questionIndexByRequestKey } =
        state.questionIndexByRequestKey;
      return { answersByRequestKey, questionIndexByRequestKey };
    }),
}));

/** Keep the visible answer in the normal draft until this composer successfully submits it. */
export function setPendingUserInputComposerAnswer(
  target: ComposerThreadTarget,
  requestKey: string,
  question: Pick<UserInputQuestion, "id" | "initialAnswer" | "multiSelect">,
  customAnswer: string,
): void {
  useComposerDraftStore.getState().setPrompt(target, customAnswer);
  usePendingUserInputDraftStore.getState().setAnswersByRequestKey((existing) => ({
    ...existing,
    [requestKey]: {
      ...existing[requestKey],
      [question.id]: setPendingUserInputCustomAnswer(
        existing[requestKey]?.[question.id],
        customAnswer,
        question,
      ),
    },
  }));
}
