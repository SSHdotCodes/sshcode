import { splitPromptIntoComposerSegments } from "./composer-editor-mentions";
import type { ThreadContextRecord, UserInputQuestion } from "@t3tools/contracts";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { formatThreadLink } from "@t3tools/shared/threadLinks";

/** Question responses carry text, so send thread chips as links with the actual thread IDs. */
export function projectPendingUserInputAnswer(
  answer: unknown,
  threadContexts: ReadonlyArray<ThreadContextRecord>,
) {
  if (typeof answer !== "string" || threadContexts.length === 0) return answer;
  const recordsById = new Map(threadContexts.map((record) => [record.contextId, record]));
  return replaceComposerContextReferences(answer, (reference) => {
    const record = reference.kind === "thread" ? recordsById.get(reference.contextId) : undefined;
    return record ? formatThreadLink(record.threadId, reference.label) : reference.source;
  });
}

export interface PendingUserInputDraftAnswer {
  selectedOptionValues?: string[];
  customAnswer?: string;
  /** A pre-existing composer must retain its editor instance, selection and formatting. */
  keepComposerEditor?: boolean;
  attachmentCount?: number;
  attachmentsBlocked?: boolean;
}

export interface PendingUserInputProgress {
  questionIndex: number;
  activeQuestion: UserInputQuestion | null;
  activeDraft: PendingUserInputDraftAnswer | undefined;
  selectedOptionValues: string[];
  customAnswer: string;
  resolvedAnswer: string | string[] | null;
  usingCustomAnswer: boolean;
  answeredQuestionCount: number;
  isLastQuestion: boolean;
  isComplete: boolean;
  canAdvance: boolean;
}

function normalizeDraftAnswer(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSelectedOptionValues(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  // Provider option IDs must stay unchanged, including whitespace.
  return Array.from(new Set(value.filter((entry) => typeof entry === "string")));
}

export function resolvePendingUserInputAnswer(
  question: UserInputQuestion & { readonly required?: boolean | undefined },
  draft: PendingUserInputDraftAnswer | undefined,
): string | string[] | null {
  if (draft?.attachmentsBlocked) return null;
  const customAnswer =
    question.allowCustomAnswer === false
      ? null
      : question.initialAnswer !== undefined
        ? (draft?.customAnswer ?? null)
        : normalizeDraftAnswer(draft?.customAnswer);
  const selectedOptionValues = normalizeSelectedOptionValues(draft?.selectedOptionValues).filter(
    (value) => question.options.some((option) => (option.value ?? option.label) === value),
  );
  if (customAnswer !== null && customAnswer.length > 0) {
    // A multiple-choice answer can be both: the chosen options, then the user's own words.
    return question.multiSelect && selectedOptionValues.length > 0
      ? [...selectedOptionValues, customAnswer]
      : customAnswer;
  }
  if (question.required === false && question.options.length === 0) {
    return "";
  }

  if (question.multiSelect) {
    return selectedOptionValues.length > 0
      ? selectedOptionValues
      : (customAnswer ??
          (question.allowCustomAnswer !== false && (draft?.attachmentCount ?? 0) > 0 ? "" : null));
  }

  return (
    selectedOptionValues[0] ??
    customAnswer ??
    (question.allowCustomAnswer !== false && (draft?.attachmentCount ?? 0) > 0 ? "" : null)
  );
}

export function setPendingUserInputCustomAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
  question?: Pick<UserInputQuestion, "initialAnswer" | "multiSelect">,
): PendingUserInputDraftAnswer {
  // Typing replaces the choice of a single-choice question and adds to a multiple-choice one.
  const selectedOptionValues =
    question?.initialAnswer !== undefined ||
    (customAnswer.trim().length > 0 && question?.multiSelect !== true)
      ? undefined
      : normalizeSelectedOptionValues(draft?.selectedOptionValues);

  return {
    ...(draft?.keepComposerEditor ? { keepComposerEditor: true } : {}),
    customAnswer,
    ...(selectedOptionValues && selectedOptionValues.length > 0 ? { selectedOptionValues } : {}),
  };
}

/** Adopt only on arrival; navigating to another question must not copy the previous answer. */
export function initializePendingUserInputDraft(
  questions: ReadonlyArray<UserInputQuestion>,
  drafts: Record<string, PendingUserInputDraftAnswer> | undefined,
  questionIndex: number,
  prompt: string,
): Record<string, PendingUserInputDraftAnswer> {
  if (drafts !== undefined) return drafts;
  const question = questions[Math.max(0, Math.min(questionIndex, questions.length - 1))];
  return question && question.allowCustomAnswer !== false && prompt.length > 0
    ? {
        [question.id]: {
          ...setPendingUserInputCustomAnswer(undefined, prompt, question),
          ...(question.initialAnswer !== undefined ? { keepComposerEditor: true } : {}),
        },
      }
    : {};
}

/** Read the editor at the event boundary, including a keystroke not rendered into the answer yet. */
export function pendingUserInputAnswersForSend(
  questions: ReadonlyArray<UserInputQuestion>,
  drafts: Record<string, PendingUserInputDraftAnswer>,
  questionIndex: number,
  prompt: string,
) {
  const question = questions[questionIndex];
  return buildPendingUserInputAnswers(
    questions,
    question && question.allowCustomAnswer !== false
      ? {
          ...drafts,
          [question.id]: {
            ...drafts[question.id],
            ...setPendingUserInputCustomAnswer(drafts[question.id], prompt, question),
          },
        }
      : drafts,
  );
}

/** Answers carry text; retain chips and their normal-draft payloads for a later message. */
export function promptAfterPendingUserInputSubmit(prompt: string, submitted: string): string {
  if (prompt !== submitted) return prompt;
  const chips = splitPromptIntoComposerSegments(prompt)
    .filter((segment) => segment.type !== "text" && segment.type !== "github-link")
    .map((segment) => segment.source);
  return chips.length > 0 ? `${chips.join(" ")} ` : "";
}

const DISPLACED_ANSWER_SEPARATOR = "\n\n";

/**
 * Selecting an option of a single-choice question replaces the custom answer,
 * because a non-empty custom answer outranks the selected option in
 * `resolvePendingUserInputAnswer`. Text the user typed into the answer field
 * must not vanish on that click: it moves back into the thread draft, after
 * whatever was already waiting there. A multiple-choice question keeps the text
 * as part of the answer, so nothing is displaced there.
 */
export function carryDisplacedCustomAnswerIntoPrompt(
  prompt: string,
  customAnswer: string | undefined,
): string {
  const displaced = customAnswer?.trim() ?? "";
  if (displaced.length === 0 || prompt === customAnswer) {
    return prompt;
  }
  if (prompt.trim().length === 0) {
    return displaced;
  }
  return `${prompt.trimEnd()}${DISPLACED_ANSWER_SEPARATOR}${displaced}`;
}

/**
 * Stop cancels an open question and a provider timeout expires it; neither sends
 * the typed answers, so they go back into the thread draft after whatever is
 * already there. A seeded suggestion the user never edited is not their text.
 */
export function carryUnsentAnswersIntoPrompt(
  prompt: string,
  questions: ReadonlyArray<Pick<UserInputQuestion, "id" | "initialAnswer">>,
  drafts: Readonly<Record<string, PendingUserInputDraftAnswer>>,
): { prompt: string; carriedQuestionIds: string[] } {
  let nextPrompt = prompt;
  const carriedQuestionIds: string[] = [];
  for (const question of questions) {
    const customAnswer = drafts[question.id]?.customAnswer;
    if (customAnswer === undefined || customAnswer === question.initialAnswer) continue;
    if (customAnswer === prompt && customAnswer.trim().length > 0) {
      carriedQuestionIds.push(question.id);
      continue;
    }
    const carried = carryDisplacedCustomAnswerIntoPrompt(nextPrompt, customAnswer);
    if (carried === nextPrompt) continue;
    nextPrompt = carried;
    carriedQuestionIds.push(question.id);
  }
  return { prompt: nextPrompt, carriedQuestionIds };
}

export function togglePendingUserInputOptionSelection(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionValue: string,
): PendingUserInputDraftAnswer {
  if (question.multiSelect) {
    const selectedOptionValues = normalizeSelectedOptionValues(draft?.selectedOptionValues);
    const nextSelectedOptionValues = selectedOptionValues.includes(optionValue)
      ? selectedOptionValues.filter((value) => value !== optionValue)
      : [...selectedOptionValues, optionValue];

    return {
      ...(draft?.keepComposerEditor ? { keepComposerEditor: true } : {}),
      customAnswer: draft?.customAnswer ?? "",
      ...(nextSelectedOptionValues.length > 0
        ? { selectedOptionValues: nextSelectedOptionValues }
        : {}),
    };
  }

  return {
    customAnswer: "",
    selectedOptionValues: [optionValue],
  };
}

export function buildPendingUserInputAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): Record<string, string | string[]> | null {
  const entries: Array<[string, string | string[]]> = [];

  for (const question of questions) {
    const answer = resolvePendingUserInputAnswer(question, draftAnswers[question.id]);
    if (answer === null) {
      return null;
    }
    entries.push([question.id, answer]);
  }

  return Object.fromEntries(entries);
}

export function countAnsweredPendingUserInputQuestions(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  return questions.reduce((count, question) => {
    return resolvePendingUserInputAnswer(question, draftAnswers[question.id]) !== null
      ? count + 1
      : count;
  }, 0);
}

export function findFirstUnansweredPendingUserInputQuestionIndex(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  const unansweredIndex = questions.findIndex(
    (question) => resolvePendingUserInputAnswer(question, draftAnswers[question.id]) === null,
  );

  return unansweredIndex === -1 ? Math.max(questions.length - 1, 0) : unansweredIndex;
}

export function derivePendingUserInputProgress(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
  questionIndex: number,
): PendingUserInputProgress {
  const normalizedQuestionIndex =
    questions.length === 0 ? 0 : Math.max(0, Math.min(questionIndex, questions.length - 1));
  const activeQuestion = questions[normalizedQuestionIndex] ?? null;
  const activeDraft = activeQuestion ? draftAnswers[activeQuestion.id] : undefined;
  const resolvedAnswer = activeQuestion
    ? resolvePendingUserInputAnswer(activeQuestion, activeDraft)
    : null;
  const customAnswer =
    activeQuestion?.allowCustomAnswer === false ? "" : (activeDraft?.customAnswer ?? "");
  const answeredQuestionCount = countAnsweredPendingUserInputQuestions(questions, draftAnswers);
  const isLastQuestion =
    questions.length === 0 ? true : normalizedQuestionIndex >= questions.length - 1;

  return {
    questionIndex: normalizedQuestionIndex,
    activeQuestion,
    activeDraft,
    selectedOptionValues: normalizeSelectedOptionValues(activeDraft?.selectedOptionValues),
    customAnswer,
    resolvedAnswer,
    usingCustomAnswer:
      (activeQuestion?.initialAnswer !== undefined ? customAnswer : customAnswer.trim()).length > 0,
    answeredQuestionCount,
    isLastQuestion,
    isComplete: buildPendingUserInputAnswers(questions, draftAnswers) !== null,
    canAdvance: resolvedAnswer !== null,
  };
}
