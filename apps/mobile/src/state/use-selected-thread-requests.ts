import { useServerConfigs } from "./entities";
import { Alert } from "react-native";
import {
  questionAttachmentDraftKey,
  questionAttachmentDraftPrefix,
  questionAttachmentPreparationAtom,
} from "./question-attachments";
import {
  composerDraftsAtom,
  clearComposerDraft,
  getComposerDraftSnapshot,
  setComposerDraftText,
} from "./use-composer-drafts";
import {
  composerAttachmentUploadsAtom,
  composerAttachmentUploadBlockReason,
  composerAttachmentsStillUploading,
} from "./composer-attachment-uploads";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { type ProviderApprovalDecision, type RuntimeRequestId } from "@t3tools/contracts";
import {
  type PendingThreadRequests,
  type ThreadUserInputQuestion,
  seedUserInputDraftAnswers,
} from "@t3tools/client-runtime/state/thread-requests";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { threadEnvironment } from "../state/threads";
import { scopedThreadKey, scopedRequestKey } from "../lib/scopedEntities";
import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../lib/threadActivity";
import { appAtomRegistry } from "./atom-registry";
import { acknowledgedUserInputKeysAtom, pendingSends, pendingSendMetadata } from "./pending-sends";
import { useSelectedThreadPendingRequests } from "./use-thread-detail";
import { useThreadSelection } from "./use-thread-selection";
import { useAtomCommand } from "./use-atom-command";
import { readEnvironmentScope } from "./session";

const restoredPendingAnswerIds = new Map<string, string>();

const EMPTY_PENDING_REQUESTS: PendingThreadRequests = { approvals: [], userInputs: [] };

const userInputDraftsByRequestKeyAtom = Atom.make<
  Record<string, Record<string, PendingUserInputDraftAnswer>>
>({}).pipe(Atom.keepAlive, Atom.withLabel("mobile:user-input-drafts"));

// The last edited question owns the existing composer on multi-question cards.
const composerQuestionIdsAtom = Atom.make<Record<string, string>>({}).pipe(Atom.keepAlive);

function setUserInputDraftOption(
  requestKey: string,
  question: ThreadUserInputQuestion,
  value: string,
): void {
  const current = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
  appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {
    ...current,
    [requestKey]: {
      ...current[requestKey],
      [question.id]: togglePendingUserInputOptionSelection(
        question,
        current[requestKey]?.[question.id],
        value,
      ),
    },
  });
}

/**
 * The typed answer a submit sends. It is typed in the message box, so the box's text wins;
 * an empty box keeps the card's own answer, which is what a retry after a failed send has.
 */
export function typedAnswerForSubmit(boxText: string, cardAnswer: string | undefined): string {
  return boxText.length > 0 ? boxText : (cardAnswer ?? "");
}

/**
 * Whether the message box still holds the answer that was just sent. The box mirrors the
 * typed answer while the question is open, so a sent answer must not stay behind as a draft.
 */
export function sentAnswerStillInBox(boxText: string, sentAnswer: string): boolean {
  return sentAnswer.length > 0 && boxText === sentAnswer;
}

function setUserInputDraftCustomAnswer(
  requestKey: string,
  question: ThreadUserInputQuestion,
  customAnswer: string,
): void {
  const current = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
  appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {
    ...current,
    [requestKey]: {
      ...current[requestKey],
      [question.id]: setPendingUserInputCustomAnswer(
        question,
        current[requestKey]?.[question.id],
        customAnswer,
      ),
    },
  });
}

export function useSelectedThreadRequests(composerDraftKey?: string | null) {
  const respondToApproval = useAtomCommand(
    threadEnvironment.respondToApproval,
    "thread approval response",
  );
  const dismissUserInput = useAtomCommand(
    threadEnvironment.dismissUserInput,
    "thread user input dismissal",
  );
  const { selectedThread: selectedThreadShell, selectedEnvironmentRuntime } = useThreadSelection();
  const queuedSends = useAtomValue(pendingSends.sendsAtom);
  const acknowledgedInputs = useAtomValue(acknowledgedUserInputKeysAtom);
  const pendingRequests = useSelectedThreadPendingRequests();
  const userInputDraftsByRequestKey = useAtomValue(userInputDraftsByRequestKeyAtom);
  const composerQuestionIds = useAtomValue(composerQuestionIdsAtom);
  const userInputResponsesInFlight = useRef(new Set<string>());
  const approvalResponsesInFlight = useRef(new Set<string>());
  const [respondingApprovalId, setRespondingApprovalId] = useState<RuntimeRequestId | null>(null);
  const [respondingUserInputId, setRespondingUserInputId] = useState<RuntimeRequestId | null>(null);

  const activePendingApprovals = pendingRequests?.approvals ?? EMPTY_PENDING_REQUESTS.approvals;
  const activePendingApproval = activePendingApprovals[0] ?? null;
  const activePendingUserInputs = pendingRequests?.userInputs ?? EMPTY_PENDING_REQUESTS.userInputs;
  const activePendingUserInput = activePendingUserInputs[0] ?? null;
  const activeRequestKey =
    activePendingUserInput && selectedThreadShell
      ? scopedRequestKey(selectedThreadShell.environmentId, activePendingUserInput.requestId)
      : "";
  const activePendingUserInputQuestionId =
    activePendingUserInput?.questions.find(
      (question) => question.id === composerQuestionIds[activeRequestKey],
    )?.id ??
    activePendingUserInput?.questions[0]?.id ??
    null;
  const queuedAnswer = queuedSends.find(
    (send) =>
      send.kind === "user-input" &&
      send.environmentId === selectedThreadShell?.environmentId &&
      send.threadId === selectedThreadShell?.id &&
      send.requestId === activePendingUserInput?.requestId,
  );
  const answerAcknowledged =
    activePendingUserInput !== null &&
    selectedThreadShell !== null &&
    acknowledgedInputs.has(
      `${selectedThreadShell.environmentId}:${selectedThreadShell.id}:user-input:${activePendingUserInput.requestId}`,
    );
  const userInputDeliveryStatus = answerAcknowledged
    ? "Answer sent"
    : queuedAnswer
      ? (queuedAnswer.error ?? "Waiting for network…")
      : null;
  useEffect(() => {
    if (!selectedThreadShell || pendingRequests === null) return;
    const prefix = `${selectedThreadShell.environmentId}:${selectedThreadShell.id}:user-input:`;
    const retained = new Set(
      activePendingUserInputs.map((request) => `${prefix}${request.requestId}`),
    );
    const current = appAtomRegistry.get(acknowledgedUserInputKeysAtom);
    if (current !== acknowledgedInputs) return;
    const next = new Set(
      [...current].filter((key) => !key.startsWith(prefix) || retained.has(key)),
    );
    if (next.size !== current.size) appAtomRegistry.set(acknowledgedUserInputKeysAtom, next);
  }, [acknowledgedInputs, activePendingUserInputs, pendingRequests, selectedThreadShell]);
  useLayoutEffect(() => {
    if (!activePendingUserInput || !selectedThreadShell) return;
    const requestKey = scopedRequestKey(
      selectedThreadShell.environmentId,
      activePendingUserInput.requestId,
    );
    const existing = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
    const drafts = existing[requestKey] ?? {};
    let restored = drafts;
    if (
      queuedAnswer?.kind === "user-input" &&
      restoredPendingAnswerIds.get(requestKey) !== queuedAnswer.id
    ) {
      restoredPendingAnswerIds.set(requestKey, queuedAnswer.id);
      restored = { ...drafts };
      for (const question of activePendingUserInput.questions) {
        const answer = queuedAnswer.answers[question.id];
        if (typeof answer === "string") {
          restored[question.id] = question.options.some((option) => option.label === answer)
            ? { selectedOptionValues: [answer] }
            : { customAnswer: answer };
        } else if (Array.isArray(answer) && answer.every((value) => typeof value === "string")) {
          restored[question.id] = { selectedOptionValues: answer };
        }
      }
    }
    const composerKey =
      composerDraftKey ??
      scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const text = getComposerDraftSnapshot(composerKey).text;
    const question = activePendingUserInput.questions.find(
      (entry) => entry.id === activePendingUserInputQuestionId,
    );
    if (
      existing[requestKey] === undefined &&
      question?.allowCustomAnswer !== false &&
      question &&
      text.length > 0
    ) {
      restored = {
        ...restored,
        [question.id]: setPendingUserInputCustomAnswer(question, restored[question.id], text),
      };
    }
    const seeded = seedUserInputDraftAnswers(activePendingUserInput.questions, restored);
    const initialText = question ? seeded[question.id]?.customAnswer : undefined;
    if (existing[requestKey] === undefined && text.length === 0 && initialText) {
      setComposerDraftText(composerKey, initialText);
    }
    if (seeded !== drafts || existing[requestKey] === undefined) {
      appAtomRegistry.set(userInputDraftsByRequestKeyAtom, { ...existing, [requestKey]: seeded });
    }
  }, [
    activePendingUserInput,
    activePendingUserInputQuestionId,
    queuedAnswer,
    selectedThreadShell,
    composerDraftKey,
  ]);
  const questionServerConfigs = useServerConfigs();
  const attachmentDrafts = useAtomValue(composerDraftsAtom);
  const preparationCounts = useAtomValue(questionAttachmentPreparationAtom);
  const uploadStates = useAtomValue(composerAttachmentUploadsAtom);
  useEffect(() => {
    if (!selectedThreadShell || !pendingRequests) return;
    const prefix = questionAttachmentDraftPrefix(
      selectedThreadShell.environmentId,
      selectedThreadShell.id,
    );
    const retained = new Set(
      activePendingUserInputs.flatMap((request) =>
        request.questions.map((question) =>
          questionAttachmentDraftKey(
            selectedThreadShell.environmentId,
            selectedThreadShell.id,
            request.requestId,
            question.id,
          ),
        ),
      ),
    );
    const counts = { ...appAtomRegistry.get(questionAttachmentPreparationAtom) };
    let changed = false;
    for (const key of new Set([...Object.keys(attachmentDrafts), ...Object.keys(counts)])) {
      if (!key.startsWith(prefix) || retained.has(key)) continue;
      if (attachmentDrafts[key]) clearComposerDraft(key);
      if (key in counts) {
        delete counts[key];
        changed = true;
      }
    }
    if (changed) appAtomRegistry.set(questionAttachmentPreparationAtom, counts);
  }, [activePendingUserInputs, attachmentDrafts, pendingRequests, selectedThreadShell]);
  const activePendingUserInputDrafts =
    activePendingUserInput && selectedThreadShell
      ? Object.fromEntries(
          activePendingUserInput.questions.map((question) => {
            const key = questionAttachmentDraftKey(
              selectedThreadShell.environmentId,
              selectedThreadShell.id,
              activePendingUserInput.requestId,
              question.id,
            );
            const attachments = attachmentDrafts[key]?.attachments ?? [];
            const uploadInput = {
              environmentId: selectedThreadShell.environmentId,
              attachments,
              serverConfig: questionServerConfigs.get(selectedThreadShell.environmentId) ?? null,
              states: uploadStates,
            };
            return [
              question.id,
              {
                ...userInputDraftsByRequestKey[
                  scopedRequestKey(
                    selectedThreadShell.environmentId,
                    activePendingUserInput.requestId,
                  )
                ]?.[question.id],
                attachmentCount: attachments.length,
                attachmentsBlocked:
                  (attachments.length > 0 &&
                    questionServerConfigs.get(selectedThreadShell.environmentId)?.environment
                      .capabilities.questionAttachments !== true) ||
                  (preparationCounts[key] ?? 0) > 0 ||
                  composerAttachmentsStillUploading(uploadInput) ||
                  composerAttachmentUploadBlockReason({
                    ...uploadInput,
                    connected: true,
                  }) !== null,
              },
            ];
          }),
        )
      : {};
  const activePendingUserInputAnswers = activePendingUserInput
    ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingUserInputDrafts)
    : null;

  const onSelectUserInputOption = useCallback(
    (requestId: RuntimeRequestId, question: ThreadUserInputQuestion, value: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const requestKey = scopedRequestKey(selectedThreadShell.environmentId, requestId);
      setUserInputDraftOption(requestKey, question, value);
    },
    [selectedThreadShell],
  );

  const onChangeUserInputCustomAnswer = useCallback(
    (requestId: RuntimeRequestId, questionId: string, customAnswer: string) => {
      const question = activePendingUserInputs
        .find((request) => request.requestId === requestId)
        ?.questions.find((entry) => entry.id === questionId);
      if (!selectedThreadShell || !question) {
        return;
      }

      const requestKey = scopedRequestKey(selectedThreadShell.environmentId, requestId);
      setUserInputDraftCustomAnswer(requestKey, question, customAnswer);
      if (activePendingUserInput?.requestId === requestId) {
        const questionIds = appAtomRegistry.get(composerQuestionIdsAtom);
        if (questionIds[requestKey] !== questionId)
          appAtomRegistry.set(composerQuestionIdsAtom, {
            ...questionIds,
            [requestKey]: questionId,
          });
        setComposerDraftText(
          composerDraftKey ??
            scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id),
          customAnswer,
        );
      }
    },
    [activePendingUserInput, activePendingUserInputs, selectedThreadShell, composerDraftKey],
  );

  const onRespondToApproval = useCallback(
    async (requestId: RuntimeRequestId, decision: ProviderApprovalDecision) => {
      if (
        !selectedThreadShell ||
        !readEnvironmentScope(selectedThreadShell.environmentId, AuthOrchestrationOperateScope)
      ) {
        return;
      }
      if (
        activePendingApprovals.find((approval) => approval.requestId === requestId)
          ?.responseCapability !== "live"
      ) {
        return;
      }
      if (approvalResponsesInFlight.current.has(requestId)) return;

      approvalResponsesInFlight.current.add(requestId);
      setRespondingApprovalId(requestId);
      const result = await respondToApproval({
        environmentId: selectedThreadShell.environmentId,
        input: {
          threadId: selectedThreadShell.id,
          requestId,
          decision,
        },
      });
      approvalResponsesInFlight.current.delete(requestId);
      setRespondingApprovalId((current) => (current === requestId ? null : current));
      return result;
    },
    [activePendingApprovals, respondToApproval, selectedThreadShell],
  );

  const onSubmitUserInput = useCallback(async () => {
    if (
      !selectedThreadShell ||
      !activePendingUserInput ||
      activePendingUserInput.responseCapability === "not_resumable" ||
      (selectedEnvironmentRuntime?.connectionState === "connected" &&
        !readEnvironmentScope(selectedThreadShell.environmentId, AuthOrchestrationOperateScope))
    ) {
      return;
    }

    const composerKey =
      composerDraftKey ??
      scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const composerDraft = getComposerDraftSnapshot(composerKey);
    const questionId =
      appAtomRegistry.get(composerQuestionIdsAtom)[activeRequestKey] ??
      activePendingUserInput.questions[0]?.id;
    const question = activePendingUserInput.questions.find((entry) => entry.id === questionId);
    const currentDrafts = appAtomRegistry.get(userInputDraftsByRequestKeyAtom)[
      scopedRequestKey(selectedThreadShell.environmentId, activePendingUserInput.requestId)
    ];
    const drafts: Record<string, PendingUserInputDraftAnswer> = { ...activePendingUserInputDrafts };
    for (const entry of activePendingUserInput.questions) {
      drafts[entry.id] = { ...drafts[entry.id], ...currentDrafts?.[entry.id] };
    }
    const optionSelected =
      question &&
      drafts[question.id]?.customAnswer === "" &&
      (drafts[question.id]?.selectedOptionValues?.length ?? 0) > 0;
    let typedAnswer: string | null = null;
    if (question && question.allowCustomAnswer !== false && !optionSelected) {
      typedAnswer = typedAnswerForSubmit(composerDraft.text, drafts[question.id]?.customAnswer);
      drafts[question.id] = {
        ...drafts[question.id],
        ...setPendingUserInputCustomAnswer(question, drafts[question.id], typedAnswer),
      };
    }
    const answers = buildPendingUserInputAnswers(activePendingUserInput.questions, drafts);
    if (!answers) return;

    const responseKey = questionAttachmentDraftKey(
      selectedThreadShell.environmentId,
      selectedThreadShell.id,
      activePendingUserInput.requestId,
      "",
    );
    if (userInputResponsesInFlight.current.has(responseKey)) return;
    const attachmentsByQuestionId = new Map<
      string,
      import("@t3tools/contracts").UserInputAttachments[string]
    >();
    for (const question of activePendingUserInput.questions) {
      const key = questionAttachmentDraftKey(
        selectedThreadShell.environmentId,
        selectedThreadShell.id,
        activePendingUserInput.requestId,
        question.id,
      );
      if ((appAtomRegistry.get(questionAttachmentPreparationAtom)[key] ?? 0) > 0) return;
      const attachments = appAtomRegistry.get(composerDraftsAtom)[key]?.attachments ?? [];
      if (attachments.length === 0) continue;
      if (
        attachments.some(
          (attachment) =>
            !attachment.uploadedAttachmentId ||
            attachment.uploadEnvironmentId !== selectedThreadShell.environmentId,
        )
      ) {
        Alert.alert(
          "Attachments are not ready",
          "Wait for uploads to finish, or retry failed uploads.",
        );
        return;
      }
      attachmentsByQuestionId.set(
        question.id,
        attachments.map((attachment) => ({
          type: attachment.type,
          id: attachment.uploadedAttachmentId!,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        })),
      );
    }
    userInputResponsesInFlight.current.add(responseKey);
    setRespondingUserInputId(activePendingUserInput.requestId);
    try {
      await pendingSends.enqueue({
        ...pendingSendMetadata(),
        kind: "user-input",
        environmentId: selectedThreadShell.environmentId,
        threadId: selectedThreadShell.id,
        requestId: activePendingUserInput.requestId,
        answers,
        ...(attachmentsByQuestionId.size > 0
          ? { attachmentsByQuestionId: Object.fromEntries(attachmentsByQuestionId) }
          : {}),
      });
      // The answer was typed in the message box: once sent, it must not stay there as a
      // draft (it stayed, and seeded the next question too).
      if (
        typedAnswer !== null &&
        sentAnswerStillInBox(getComposerDraftSnapshot(composerKey).text, typedAnswer)
      ) {
        setComposerDraftText(composerKey, "");
      }
    } catch {
      Alert.alert(
        "Could not save your answer",
        "Your answer is still in the question card. Try sending again.",
      );
    } finally {
      userInputResponsesInFlight.current.delete(responseKey);
      setRespondingUserInputId((current) =>
        current === activePendingUserInput.requestId ? null : current,
      );
    }
  }, [
    activePendingUserInput,
    activePendingUserInputDrafts,
    activeRequestKey,
    composerDraftKey,
    selectedThreadShell,
    selectedEnvironmentRuntime?.connectionState,
  ]);

  // Closes an async question without messaging the agent.
  const onDismissUserInput = useCallback(async () => {
    if (
      !selectedThreadShell ||
      !activePendingUserInput ||
      !activePendingUserInput.dismissible ||
      !readEnvironmentScope(selectedThreadShell.environmentId, AuthOrchestrationOperateScope)
    ) {
      return;
    }

    const responseKey = questionAttachmentDraftKey(
      selectedThreadShell.environmentId,
      selectedThreadShell.id,
      activePendingUserInput.requestId,
      "",
    );
    if (userInputResponsesInFlight.current.has(responseKey)) return;
    userInputResponsesInFlight.current.add(responseKey);
    setRespondingUserInputId(activePendingUserInput.requestId);
    const result = await dismissUserInput({
      environmentId: selectedThreadShell.environmentId,
      input: {
        threadId: selectedThreadShell.id,
        requestId: activePendingUserInput.requestId,
      },
    });
    userInputResponsesInFlight.current.delete(responseKey);
    setRespondingUserInputId((current) =>
      current === activePendingUserInput.requestId ? null : current,
    );
    return result;
  }, [activePendingUserInput, dismissUserInput, selectedThreadShell]);

  return {
    activePendingApproval,
    activePendingUserInput,
    activePendingUserInputQuestionId,
    activePendingUserInputDrafts,
    activePendingUserInputAnswers,
    respondingApprovalId,
    respondingUserInputId: answerAcknowledged
      ? activePendingUserInput!.requestId
      : queuedAnswer && !queuedAnswer.error && queuedAnswer.kind === "user-input"
        ? queuedAnswer.requestId
        : respondingUserInputId,
    userInputDeliveryStatus,
    onRespondToApproval,
    onSelectUserInputOption,
    onChangeUserInputCustomAnswer,
    onSubmitUserInput,
    onDismissUserInput,
  };
}
