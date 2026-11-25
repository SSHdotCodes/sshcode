import { markLoad } from "@t3tools/client-runtime/load-marks";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { readEnvironmentScope } from "./session";
import type { ComposerTextPaste } from "../native/T3ComposerEditor.types";
import { useAtomValue } from "@effect/atom-react";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import { resolvePendingHandoff } from "@t3tools/client-runtime/handoff";
import {
  deriveProviderSubagentStatus,
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveThreadRuntime,
  threadRuntimeHasInterruptibleRun,
} from "@t3tools/client-runtime/state/thread-execution";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";

import {
  CommandId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import { nextPastedTextFileName, pastedTextDisposition } from "@t3tools/client-runtime/text-paste";
import {
  parseCodexFeedbackCommand,
  submitCodexFeedback,
  type CodexFeedbackSubmission,
} from "@t3tools/client-runtime/state/threads";
import { resolveThreadWorkingStartedAt } from "@t3tools/client-runtime/state/models";
import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";
import { composerContextSendBlockReason, reidentifyComposerContext } from "../lib/composerContext";
import { uuidv4 } from "../lib/uuid";

import { makeQueuedMessageMetadata } from "../lib/commandMetadata";
import {
  describeUnavailableModelSelection,
  isModelSelectionUnavailable,
  modelSelectionForDispatch,
} from "../lib/modelOptions";
import { resolveProviderInteractionMode } from "./legacy-plan-mode";
import {
  convertPastedImagesToAttachments,
  createPastedTextComposerAttachment,
  pasteComposerClipboard,
  pickComposerFiles,
  pickComposerMedia,
  removePersistedComposerAttachmentFile,
} from "../lib/composerImages";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { scopedThreadKey } from "../lib/scopedEntities";
import { createThreadFeedProjector } from "../lib/threadFeedProjection";
import {
  acknowledgedThreadMessageSequence,
  retireAcknowledgedThreadMessages,
  acknowledgedThreadMessagesAtom,
  echoedAcknowledgedMessageIds,
} from "./acknowledged-thread-messages";
import { appendPendingThreadMessages } from "./pending-thread-feed";
import { threadAllowsProviderSwitch } from "./thread-provider-switching";
import { appAtomRegistry } from "../state/atom-registry";
import { pendingThreadCreationMessage } from "./pending-thread-creation";
import {
  composerAttachmentUploadBlockReason,
  composerAttachmentUploadsAtom,
} from "../state/composer-attachment-uploads";
import {
  appendComposerDraftAttachments,
  captureComposerDraftInsertion,
  countComposerDraftAttachmentsAfterSelection,
  insertComposerDraftText,
  insertComposerDraftContext,
  clearComposerDraftContent,
  composerDraftsAtom,
  composerContextImportsAtom,
  ensureComposerDraftsLoaded,
  getComposerDraftSnapshot,
  removeComposerDraftAttachment,
  scheduleUnusedComposerAttachmentCleanup,
  setComposerDraftText,
  setStickyComposerModelSelection,
  useComposerDraft,
} from "./use-composer-drafts";
import {
  resolveComposerDispatchMode,
  type ActiveTurnComposerAction,
} from "@t3tools/client-runtime/state/composer-dispatch";
import { Atom } from "effect/reactivity";
import { AsyncResult } from "effect/reactivity";
import { prepareTurnAttachments } from "../lib/attachmentUpload";
import { DEFAULT_FOLLOW_UP_BEHAVIOR } from "../lib/followUpBehavior";
import { mobilePreferencesAtom } from "./preferences";
import { environmentThreadDetails } from "./threads";
import {
  endQueuedRunEdit,
  getQueuedRunEdit,
  claimQueuedRunEditSave,
  useQueuedRunEditSaving,
  queuedEditDraftKey,
  removeQueuedRunEditAttachment,
  resolveQueuedEditPayload,
  useQueuedRunEdit,
} from "./queued-run-edit";
import { setPendingConnectionError } from "../state/use-remote-environment-registry";
import { clearThreadComposerError, setThreadComposerError } from "./thread-composer-error";
import {
  useSelectedThreadProjection,
  useSelectedThreadVisibleTurnItems,
} from "../state/use-thread-detail";
import { useThreadSelection } from "../state/use-thread-selection";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import { enqueueThreadOutboxMessage } from "./thread-outbox";
import { dispatchingMessageByThreadAtom, useThreadOutboxMessages } from "./use-thread-outbox";
import { threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";

const EMPTY_QUEUE_WORKFLOW_ATOM = Atom.make<null>(null).pipe(
  Atom.withLabel("mobile-thread-queue-workflow:empty"),
);

export function appendReviewCommentToDraft(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly attachments?: ReadonlyArray<DraftComposerImageAttachment>;
}): void {
  const threadKey = scopedThreadKey(input.environmentId, input.threadId);
  const upgraded = upgradeLegacyContextMessage(input.text);
  if (
    !insertComposerDraftContext(
      threadKey,
      reidentifyComposerContext(upgraded.text, upgraded.records, uuidv4),
    )
  ) {
    Alert.alert("Too many context items", "Remove some context from the draft and try again.");
    return;
  }
  if (input.attachments && input.attachments.length > 0) {
    // Capped: a review comment is new content, not a send-failure restore, so
    // it must not push the draft over the send limit. Overflow is released.
    const rejectedCount = appendComposerDraftAttachments(threadKey, input.attachments, {
      appendReference: true,
    });
    if (rejectedCount > 0) {
      setPendingConnectionError(
        `${rejectedCount} comment attachment${rejectedCount === 1 ? " was" : "s were"} not added. Messages can contain at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
      );
    }
  }
}

/**
 * Which draft the composer is editing right now. While a queued message is
 * being edited the composer is pointed at that edit's own draft, so typing,
 * attaching, and pasting never touch the user's draft for the thread.
 * Resolved per call rather than captured, so a callback created before the
 * edit began still writes to the right place.
 */
function activeComposerDraftKey(thread: {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
}): string {
  const threadKey = scopedThreadKey(thread.environmentId, thread.id);
  const edit = getQueuedRunEdit(threadKey);
  return edit === null ? threadKey : queuedEditDraftKey(threadKey, edit.runId);
}

export function useThreadDraftForThread(input: {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
}) {
  const threadKey =
    input.environmentId && input.threadId
      ? scopedThreadKey(input.environmentId, input.threadId)
      : null;
  const draft = useComposerDraft(threadKey);

  return {
    draftMessage: draft.text,
    draftAttachments: draft.attachments,
  };
}

const NO_WINDOW_SEQUENCE = Atom.make<number | null>(null);

export function useThreadComposerState() {
  const {
    selectedThread: selectedThreadShell,
    selectedThreadCreation,
    selectedThreadDetailRef,
    selectedEnvironmentRuntime,
  } = useThreadSelection();
  const selectedThreadProjection = useSelectedThreadProjection();
  const selectedThreadVisibleTurnItems = useSelectedThreadVisibleTurnItems();
  const composerDrafts = useAtomValue(composerDraftsAtom);
  const acknowledgedMessages = useAtomValue(acknowledgedThreadMessagesAtom);
  const boundedWindowSequence = useAtomValue(
    acknowledgedMessages.length > 0 && selectedThreadDetailRef != null
      ? environmentThreadDetails.boundedWindowSequenceAtom(selectedThreadDetailRef)
      : NO_WINDOW_SEQUENCE,
  );
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const dispatchingQueuedMessageId = useAtomValue(dispatchingMessageByThreadAtom, (byThread) =>
    selectedThreadShell
      ? (byThread[scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)] ??
        null)
      : null,
  );
  const [feedbackSubmissionsByThreadKey, setFeedbackSubmissionsByThreadKey] = useState<
    Record<string, ReadonlyArray<CodexFeedbackSubmission>>
  >({});
  const pickThreadModel = useAtomCommand(threadEnvironment.updateMetadata);
  const pickThreadRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode);
  const pickThreadInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode);
  const uploadThreadFeedback = useAtomCommand(threadEnvironment.uploadFeedback, {
    reportFailure: false,
  });
  const waitForSendConnection = useAtomCommand(threadEnvironment.waitForSendConnection, {
    reportFailure: false,
  });
  const editQueuedRun = useAtomCommand(threadEnvironment.editQueuedRun, {
    label: "edit queued message",
    reportFailure: false,
  });
  const savingQueuedEditRef = useRef(false);
  const pastedTextFileNamesRef = useRef<{ threadKey: string | null; names: Set<string> }>({
    threadKey: null,
    names: new Set(),
  });
  const reservePastedTextFileName = useCallback(
    (threadKey: string, existingNames: ReadonlyArray<string>) => {
      if (pastedTextFileNamesRef.current.threadKey !== threadKey) {
        pastedTextFileNamesRef.current = { threadKey, names: new Set() };
      }
      const names = pastedTextFileNamesRef.current.names;
      for (const name of existingNames) names.add(name);
      const nextName = nextPastedTextFileName([...names]);
      names.add(nextName);
      return nextName;
    },
    [],
  );

  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);

  const selectedThreadKey = selectedThreadShell
    ? scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
    : null;
  // The creation entry is the thread itself (rendered as the first message),
  // not a follow-up waiting behind it.
  const selectedThreadQueuedMessages = useMemo(
    () =>
      selectedThreadKey
        ? (queuedMessagesByThreadKey[selectedThreadKey] ?? []).filter(
            (message) => message.creation === undefined && !acknowledgedMessages.includes(message),
          )
        : [],
    [queuedMessagesByThreadKey, selectedThreadKey, acknowledgedMessages],
  );
  const feedbackSubmissions = useMemo(
    () => (selectedThreadKey ? (feedbackSubmissionsByThreadKey[selectedThreadKey] ?? []) : []),
    [feedbackSubmissionsByThreadKey, selectedThreadKey],
  );
  const dismissFeedback = useCallback(
    (id: MessageId) => {
      if (!selectedThreadKey) return;
      setFeedbackSubmissionsByThreadKey((current) => ({
        ...current,
        [selectedThreadKey]: (current[selectedThreadKey] ?? []).filter((entry) => entry.id !== id),
      }));
    },
    [selectedThreadKey],
  );
  const selectedThreadMessages = selectedThreadProjection?.projection.messages;
  const selectedThreadRuns = selectedThreadProjection?.projection.runs;
  const selectedThreadAttempts = selectedThreadProjection?.projection.attempts;
  const selectedThreadNodes = selectedThreadProjection?.projection.nodes;
  // A thread whose creation has not delivered its turn yet: the prompt only
  // exists in the outbox, so it is appended to whatever the server has. The
  // detail is usually present but empty during a worktree checkout, so this
  // cannot be an either/or with the loaded messages.
  const pendingCreationMessage = selectedThreadCreation?.message ?? null;
  const projectThreadFeed = useMemo(() => createThreadFeedProjector(), []);
  const echoedIds = useMemo(
    () =>
      acknowledgedMessages.length === 0
        ? null
        : echoedAcknowledgedMessageIds(
            selectedThreadVisibleTurnItems,
            selectedThreadRuns ?? [],
            selectedThreadMessages ?? [],
            acknowledgedMessages.flatMap((message) => {
              return scopedThreadKey(message.environmentId, message.threadId) !== selectedThreadKey
                ? []
                : [
                    {
                      messageId: message.messageId,
                      receiptSequence: acknowledgedThreadMessageSequence(message),
                    },
                  ];
            }),
            boundedWindowSequence,
          ),
    [
      boundedWindowSequence,
      selectedThreadVisibleTurnItems,
      selectedThreadRuns,
      selectedThreadMessages,
      acknowledgedMessages,
      selectedThreadKey,
    ],
  );
  const selectedThreadFeed = useMemo(() => {
    const pendingCreation =
      pendingCreationMessage !== null &&
      !selectedThreadMessages?.some((message) => message.id === pendingCreationMessage.messageId)
        ? [pendingThreadCreationMessage(pendingCreationMessage)]
        : [];
    const feed = projectThreadFeed(selectedThreadVisibleTurnItems, {
      anchoredMessages: pendingCreation,
      attempts: selectedThreadAttempts,
      nodes: selectedThreadNodes,
    });
    const pendingAcknowledgments = acknowledgedMessages.filter(
      (message) =>
        scopedThreadKey(message.environmentId, message.threadId) === selectedThreadKey &&
        !echoedIds?.has(message.messageId) &&
        !selectedThreadQueuedMessages.some((queued) => queued.messageId === message.messageId),
    );
    if (pendingAcknowledgments.length === 0) return feed;
    return appendPendingThreadMessages(feed, feed, pendingAcknowledgments).map((entry) =>
      entry.pendingMessage ? { ...entry, acknowledged: true } : entry,
    );
  }, [
    projectThreadFeed,
    selectedThreadMessages,
    selectedThreadAttempts,
    selectedThreadNodes,
    selectedThreadVisibleTurnItems,
    pendingCreationMessage,
    selectedThreadKey,
    selectedThreadQueuedMessages,
    acknowledgedMessages,
    echoedIds,
  ]);
  useEffect(() => {
    if (echoedIds === null) return;
    const queued = selectedThreadKey ? queuedMessagesByThreadKey[selectedThreadKey] : undefined;
    // A delayed disk removal can still publish this outbox payload. Keep its
    // receipt until both the server row and the cleanup have taken over.
    const canForget = (message: QueuedThreadMessage) =>
      scopedThreadKey(message.environmentId, message.threadId) === selectedThreadKey &&
      echoedIds.has(message.messageId) &&
      !queued?.includes(message);
    if (acknowledgedMessages.some(canForget)) {
      retireAcknowledgedThreadMessages(canForget);
    }
  }, [acknowledgedMessages, echoedIds, selectedThreadKey, queuedMessagesByThreadKey]);

  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const followUpBehavior = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.followUpBehaviorV2 ?? DEFAULT_FOLLOW_UP_BEHAVIOR)
    : DEFAULT_FOLLOW_UP_BEHAVIOR;
  // Steering needs a live provider turn the adapter can interrupt; the queue
  // workflow already derives that from the session's capabilities.
  const queueWorkflow = useAtomValue(
    selectedThreadDetailRef === null
      ? EMPTY_QUEUE_WORKFLOW_ATOM
      : environmentThreadDetails.queueWorkflowAtom(selectedThreadDetailRef),
  );
  const queuedRunEdit = useQueuedRunEdit(selectedThreadKey);
  const isSavingQueuedEdit = useQueuedRunEditSaving(selectedThreadKey);
  const composerDraftKey =
    selectedThreadKey === null
      ? null
      : queuedRunEdit === null
        ? selectedThreadKey
        : queuedEditDraftKey(selectedThreadKey, queuedRunEdit.runId);
  // Content stays in the local draft; model and mode pickers follow the shared thread.
  const editedDraft = composerDraftKey ? composerDrafts[composerDraftKey] : null;
  const draftMessage = editedDraft?.text ?? "";
  const draftAttachments = editedDraft?.attachments ?? [];
  const selectedThreadQueueCount = selectedThreadQueuedMessages.length;
  const selectedThread = selectedThreadShell;
  const modelSelection = selectedThread?.modelSelection ?? null;
  const pendingHandoff = useMemo(
    () =>
      resolvePendingHandoff(
        selectedThreadProjection?.projection,
        modelSelection,
        selectedEnvironmentRuntime?.serverConfig?.providers ?? [],
      ),
    [modelSelection, selectedThreadProjection, selectedEnvironmentRuntime?.serverConfig?.providers],
  );
  const runtimeMode = selectedThread?.runtimeMode ?? null;
  const selectedProvider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
    (provider) => provider.instanceId === modelSelection?.instanceId,
  );
  const interactionMode = selectedThread
    ? resolveProviderInteractionMode(selectedProvider, selectedThread.interactionMode)
    : null;
  // Whether the model picker may leave this thread's provider. Derived here
  // because the projection already drives this hook; the composer only needs
  // the answer, not a subscription to every projection update.
  const canSwitchThreadProvider = useMemo(
    () =>
      threadAllowsProviderSwitch({
        thread: selectedThreadShell,
        projection: selectedThreadProjection?.projection,
      }),
    [selectedThreadProjection, selectedThreadShell],
  );
  const selectedThreadRuntime = useMemo(
    () =>
      selectedThreadProjection
        ? deriveThreadRuntime(selectedThreadProjection.projection)
        : (selectedThreadShell?.runtime ?? null),
    [selectedThreadProjection, selectedThreadShell?.runtime],
  );
  const selectedThreadActivityRun = useMemo(
    () =>
      selectedThreadProjection
        ? deriveThreadActivityRun(selectedThreadProjection.projection)
        : (selectedThreadShell?.latestRun ?? null),
    [selectedThreadProjection, selectedThreadShell?.latestRun],
  );

  const isCompacting = useMemo(() => {
    const queuedCompact = selectedThreadQueuedMessages.some(
      (message) =>
        message.messageId === dispatchingQueuedMessageId &&
        message.text.trim().toLowerCase() === "/compact" &&
        message.attachments.length === 0,
    );
    if (queuedCompact) return true;
    const activeRunId = selectedThreadRuntime?.activeRunId;
    if (!activeRunId || !threadRuntimeIsActive(selectedThreadRuntime)) return false;
    const hasCompactMessage = selectedThreadVisibleTurnItems.some(
      ({ item }) =>
        item.runId === activeRunId &&
        item.type === "user_message" &&
        item.text.trim().toLowerCase() === "/compact" &&
        item.attachments.length === 0,
    );
    if (!hasCompactMessage) return false;
    return !selectedThreadVisibleTurnItems.some(
      ({ item }) =>
        item.runId === activeRunId &&
        item.type === "compaction" &&
        (item.status === "completed" || item.status === "failed"),
    );
  }, [
    dispatchingQueuedMessageId,
    selectedThreadQueuedMessages,
    selectedThreadRuntime,
    selectedThreadVisibleTurnItems,
  ]);
  // A compacting turn cannot take steering input, so follow-ups queue meanwhile.
  const canSteerActiveTurn = queueWorkflow?.canPromoteToSteer === true && !isCompacting;

  const runlessWorkStartedAt = useMemo(
    () =>
      selectedThreadProjection
        ? deriveRunlessWorkStartedAt(selectedThreadProjection.projection)
        : null,
    [selectedThreadProjection],
  );
  const activeWorkStartedAt = useMemo(() => {
    if (!selectedThreadShell) {
      return null;
    }
    return (
      resolveThreadWorkingStartedAt({
        latestRun: selectedThreadActivityRun,
        runtime: selectedThreadRuntime,
      }) ?? runlessWorkStartedAt
    );
  }, [selectedThreadActivityRun, runlessWorkStartedAt, selectedThreadRuntime, selectedThreadShell]);
  const runlessWorkActive = runlessWorkStartedAt !== null;

  const providerSubagentStatus = useMemo(
    () =>
      selectedThreadProjection
        ? deriveProviderSubagentStatus(selectedThreadProjection.projection)
        : null,
    [selectedThreadProjection],
  );

  const activeThreadBusy = threadRuntimeIsActive(selectedThreadRuntime);
  const interruptibleRunId = threadRuntimeHasInterruptibleRun(selectedThreadRuntime)
    ? (selectedThreadRuntime?.activeRunId ?? null)
    : (selectedThreadRuns?.findLast((run) => run.automaticProviderRetry?.status === "scheduled")
        ?.id ?? null);

  const cancelQueuedRunEdit = useCallback(() => {
    if (selectedThreadKey === null || savingQueuedEditRef.current) return;
    endQueuedRunEdit(selectedThreadKey);
  }, [selectedThreadKey]);

  const onRemoveQueuedEditAttachment = useCallback(
    (attachmentId: string) => {
      if (selectedThreadKey === null) return;
      removeQueuedRunEditAttachment(selectedThreadKey, attachmentId);
    },
    [selectedThreadKey],
  );

  const saveQueuedRunEdit = useCallback(async () => {
    const thread = selectedThreadShell;
    if (!thread || savingQueuedEditRef.current) return;
    const threadKey = scopedThreadKey(thread.environmentId, thread.id);
    const edit = getQueuedRunEdit(threadKey);
    if (edit === null) return;
    const draftKey = queuedEditDraftKey(threadKey, edit.runId);
    let draft = getComposerDraftSnapshot(draftKey);
    const text = draft.text.trim();
    if (text.length === 0) {
      // The server rejects an empty queued message, attachments or not.
      Alert.alert("Add a message", "A queued message cannot be left empty.");
      return;
    }
    if (
      edit.existingAttachments.length + draft.attachments.length >
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    ) {
      Alert.alert(
        "Too many attachments",
        `Remove attachments until there are at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}.`,
      );
      return;
    }
    const releaseSave = claimQueuedRunEditSave(threadKey);
    if (releaseSave === null) return;
    savingQueuedEditRef.current = true;
    try {
      if (selectedEnvironmentRuntime?.connectionState !== "connected") {
        const ready = await waitForSendConnection({
          environmentId: thread.environmentId,
          input: undefined,
        });
        if (
          ready._tag !== "Success" ||
          !readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)
        ) {
          Alert.alert("Could not send the edit", "Your edit is still in the composer.");
          return;
        }
        const latest = getComposerDraftSnapshot(draftKey);
        if (getQueuedRunEdit(threadKey) !== edit) return;
        if (
          latest.text !== draft.text ||
          latest.context !== draft.context ||
          latest.attachments.length !== draft.attachments.length ||
          latest.attachments.some((item, index) => item.id !== draft.attachments[index]?.id)
        ) {
          Alert.alert("The edit changed while reconnecting", "Review it before sending.");
          return;
        }
        draft = latest;
      }
      const capabilities = selectedEnvironmentRuntime?.serverConfig?.environment.capabilities;
      const prepared = await prepareTurnAttachments({
        environmentId: thread.environmentId,
        attachments: draft.attachments,
        supportsImageUploads: capabilities?.attachmentUploads === true,
      }).catch((error: unknown) => {
        Alert.alert(
          "Could not upload queued message attachments",
          error instanceof Error ? error.message : "Your edit is still in the composer. Try again.",
        );
        return null;
      });
      if (prepared?.status !== "ready") return;
      const payload = resolveQueuedEditPayload({
        edit,
        draftContext: draft.context,
        draftAttachments: draft.attachments,
        uploaded: prepared.attachments,
      });
      const result = await editQueuedRun({
        environmentId: thread.environmentId,
        input: {
          threadId: thread.id,
          runId: edit.runId,
          text,
          edit: {
            messageId: edit.messageId,
            attachments: payload.attachments,
            ...(payload.context ? { context: payload.context } : {}),
          },
        },
      });
      if (result._tag !== "Success") {
        Alert.alert(
          "Could not save the queued message",
          "It may have already started. Check the composer for your draft.",
        );
        return;
      }
      endQueuedRunEdit(threadKey, { deferAttachmentCleanup: true });
      scheduleUnusedComposerAttachmentCleanup(draft.attachments);
    } finally {
      releaseSave();
      savingQueuedEditRef.current = false;
    }
  }, [editQueuedRun, selectedEnvironmentRuntime, selectedThreadShell, waitForSendConnection]);

  const onSendMessage = useCallback(
    async (followUpOverride?: ActiveTurnComposerAction) => {
      const sendTappedAt = performance.now();
      if (
        selectedThreadShell &&
        selectedEnvironmentRuntime?.connectionState === "connected" &&
        !readEnvironmentScope(selectedThreadShell.environmentId, AuthOrchestrationOperateScope)
      )
        return null;
      if (!selectedThreadShell) {
        return null;
      }
      // The server has not created this thread yet. Queuing a follow-up against
      // its id would strand the message: if the creation is rejected the thread
      // never appears and the drain drops the orphan. The composer disables its
      // send button too; this guard also covers the editor's submit key.
      if (selectedThreadCreation !== null) {
        return null;
      }

      // Editing a queued message repurposes the composer: the send button saves
      // the edit in place instead of enqueuing a new message.
      const editKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      if (getQueuedRunEdit(editKey) !== null) {
        await saveQueuedRunEdit();
        return null;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      const draft = getComposerDraftSnapshot(threadKey);
      if (appAtomRegistry.get(composerContextImportsAtom)[threadKey]) return null;
      const thread = selectedThreadShell;
      const text = draft.text.trim();
      const attachments = draft.attachments;
      if (
        composerAttachmentUploadBlockReason({
          environmentId: selectedThreadShell.environmentId,
          attachments,
          connected: selectedEnvironmentRuntime?.connectionState === "connected",
          serverConfig: selectedEnvironmentRuntime?.serverConfig ?? null,
          states: appAtomRegistry.get(composerAttachmentUploadsAtom),
        }) !== null
      )
        return null;
      if (text.length === 0 && attachments.length === 0) {
        return null;
      }
      // A send-failure restore appends with restore so it never drops the
      // user's files, which can leave the draft over the cap. Sending it anyway
      // would enqueue a message that outbox recovery rejects forever, so block
      // here until the user removes attachments.
      if (attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        Alert.alert(
          "Too many attachments",
          `Remove attachments until there are at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}.`,
        );
        return null;
      }

      const contextBlockReason = composerContextSendBlockReason(draft.context);
      if (contextBlockReason) {
        Alert.alert("Too much context", contextBlockReason);
        return null;
      }

      const modelSelection = thread.modelSelection;
      const serverConfig = selectedEnvironmentRuntime?.serverConfig;
      if (
        selectedEnvironmentRuntime?.connectionState === "connected" &&
        isModelSelectionUnavailable(serverConfig, modelSelection, thread.projectId)
      ) {
        const { title, detail } = describeUnavailableModelSelection(
          serverConfig,
          modelSelection,
          thread.projectId,
        );
        Alert.alert(title, detail);
        return null;
      }
      const provider = serverConfig?.providers.find(
        (entry) => entry.instanceId === modelSelection.instanceId,
      );
      const feedbackCommand =
        attachments.length === 0 && provider?.driver === "codex"
          ? parseCodexFeedbackCommand(text)
          : null;
      if (feedbackCommand) {
        if (!readEnvironmentScope(selectedThreadShell.environmentId, AuthOrchestrationOperateScope))
          return null;
        if (thread.activeProviderThreadId === null) {
          Alert.alert("Start a Codex chat first", "Send a message before you submit feedback.");
          return null;
        }
        const metadata = makeQueuedMessageMetadata();
        await submitCodexFeedback({
          submission: {
            id: MessageId.make(metadata.messageId),
            command: text,
            createdAt: metadata.createdAt,
          },
          clearDraft: () => clearComposerDraftContent(threadKey),
          onUpdate: (submission) => {
            setFeedbackSubmissionsByThreadKey((current) => {
              const existing = current[threadKey] ?? [];
              const found = existing.some((entry) => entry.id === submission.id);
              return {
                ...current,
                [threadKey]: found
                  ? existing.map((entry) => (entry.id === submission.id ? submission : entry))
                  : [...existing, submission],
              };
            });
          },
          upload: () =>
            uploadThreadFeedback({
              environmentId: thread.environmentId,
              input: { threadId: thread.id, ...feedbackCommand },
            }),
        });
        return null;
      }

      // Resolve intent when the user sends, not when the outbox later drains.
      // A steer uses auto so a delayed delivery can start a new turn if needed.
      const followUpAction = resolveComposerDispatchMode({
        running: activeThreadBusy,
        alternateModifier: followUpOverride !== undefined && followUpOverride !== followUpBehavior,
        activeTurnDefault: followUpBehavior,
        canSteer: !isCompacting && (queueWorkflow?.canSendSteer ?? true),
      });
      const setupRunning = [selectedThreadActivityRun?.status, selectedThreadRuntime?.status].some(
        (status) => status === "preparing" || status === "starting",
      );
      const followUpDispatchMode =
        setupRunning && followUpAction === "restart"
          ? "queue"
          : followUpAction === "auto"
            ? null
            : followUpAction === "steer"
              ? "auto"
              : followUpAction;

      const metadata = makeQueuedMessageMetadata();
      const messageId = MessageId.make(metadata.messageId);
      markLoad("send.tapped", {
        environment: selectedThreadShell.environmentId.slice(0, 8),
        thread: selectedThreadShell.id.slice(0, 8),
        message: messageId.slice(-24),
        tapToQueueMs: Math.round(performance.now() - sendTappedAt),
      });
      // A new send supersedes the reason the previous one bounced back.
      clearThreadComposerError(threadKey);
      // Keep the draft until its durable outbox write lands. A suspended or
      // killed app must not persist a cleared draft ahead of the queued send.
      try {
        await enqueueThreadOutboxMessage({
          environmentId: selectedThreadShell.environmentId,
          threadId: selectedThreadShell.id,
          messageId,
          commandId: CommandId.make(metadata.commandId),
          text,
          attachments,
          context: draft.context,
          modelSelection: modelSelectionForDispatch(serverConfig, modelSelection),
          runtimeMode: thread.runtimeMode,
          interactionMode: resolveProviderInteractionMode(provider, thread.interactionMode),
          ...(followUpDispatchMode === null ? {} : { dispatchMode: followUpDispatchMode }),
          createdAt: metadata.createdAt,
        });
      } catch (error) {
        setThreadComposerError(
          threadKey,
          error instanceof Error ? error.message : "Failed to save the queued message.",
        );
        return null;
      }
      // A draft edited while the file was saving belongs to the user.
      clearComposerDraftContent(threadKey, { expectedContent: draft });
      scheduleUnusedComposerAttachmentCleanup(attachments);
      return messageId;
    },
    [
      activeThreadBusy,
      followUpBehavior,
      isCompacting,
      queueWorkflow?.canSendSteer,
      saveQueuedRunEdit,
      selectedEnvironmentRuntime?.connectionState,
      selectedEnvironmentRuntime?.serverConfig,
      selectedThreadActivityRun?.status,
      selectedThreadCreation,
      selectedThreadRuntime?.status,
      selectedThreadShell,
      uploadThreadFeedback,
    ],
  );

  const onChangeDraftMessage = useCallback(
    (value: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = activeComposerDraftKey(selectedThreadShell);
      setComposerDraftText(threadKey, value);
    },
    [selectedThreadShell],
  );

  const onPickDraftMedia = useCallback(
    async (source: "library" | "camera" = "library") => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = activeComposerDraftKey(selectedThreadShell);
      const existingQueuedCount =
        getQueuedRunEdit(scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id))
          ?.existingAttachments.length ?? 0;
      const maxAttachments = Math.max(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS - existingQueuedCount);
      const insertion = captureComposerDraftInsertion(threadKey);
      const capabilities = selectedEnvironmentRuntime?.serverConfig?.environment.capabilities;
      const result = await pickComposerMedia({
        source,
        existingCount:
          existingQueuedCount + countComposerDraftAttachmentsAfterSelection(threadKey, insertion),
        maxVideoBytes:
          capabilities?.attachmentUploads === true
            ? capabilities.fileAttachments?.maxUploadBytes
            : undefined,
      });
      const rejectedCount = appendComposerDraftAttachments(threadKey, result.attachments, {
        appendReference: true,
        insertion,
        maxAttachments,
      });
      const problems = [
        ...(result.error ? [result.error] : []),
        ...(rejectedCount > 0
          ? [`You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments per message.`]
          : []),
      ];
      if (problems.length > 0) {
        Alert.alert("Could not attach photo or video", problems.join("\n\n"));
      }
    },
    [composerDrafts, selectedEnvironmentRuntime?.serverConfig, selectedThreadShell],
  );

  const onPickDraftFiles = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }
    const maxBytes =
      selectedEnvironmentRuntime?.serverConfig?.environment.capabilities.fileAttachments
        ?.maxUploadBytes;
    if (maxBytes === undefined) {
      Alert.alert("Could not attach file", "This server does not support file attachments.");
      return;
    }

    const threadKey = activeComposerDraftKey(selectedThreadShell);
    const existingQueuedCount =
      getQueuedRunEdit(scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id))
        ?.existingAttachments.length ?? 0;
    const maxAttachments = Math.max(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS - existingQueuedCount);
    const insertion = captureComposerDraftInsertion(threadKey);
    // pickComposerFiles clamps the advertised limit to the contract maximum.
    const result = await pickComposerFiles({
      existingCount:
        existingQueuedCount + countComposerDraftAttachmentsAfterSelection(threadKey, insertion),
      maxBytes,
    });
    const rejectedCount = appendComposerDraftAttachments(threadKey, result.files, {
      appendReference: true,
      insertion,
      maxAttachments,
    });
    // The picker error and the live-cap rejection can both happen in one
    // pick; report both in a single alert.
    const problems = [
      ...(result.error ? [result.error] : []),
      ...(rejectedCount > 0
        ? [`You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`]
        : []),
    ];
    if (problems.length > 0) {
      Alert.alert("Could not attach file", problems.join("\n\n"));
    }
  }, [composerDrafts, selectedEnvironmentRuntime?.serverConfig, selectedThreadShell]);

  const onPasteIntoDraft = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = activeComposerDraftKey(selectedThreadShell);
    const existingQueuedCount =
      getQueuedRunEdit(scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id))
        ?.existingAttachments.length ?? 0;
    const maxAttachments = Math.max(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS - existingQueuedCount);
    const insertion = captureComposerDraftInsertion(threadKey);
    const result = await pasteComposerClipboard({
      existingCount:
        existingQueuedCount + countComposerDraftAttachmentsAfterSelection(threadKey, insertion),
    });
    const rejectedPasteCount = appendComposerDraftAttachments(threadKey, result.images, {
      appendReference: true,
      insertion,
      maxAttachments,
    });
    if (result.text) {
      const currentDraft = getComposerDraftSnapshot(threadKey);
      const currentAttachments = currentDraft.attachments;
      const capabilities = selectedEnvironmentRuntime?.serverConfig?.environment.capabilities;
      const advertisedMax =
        capabilities?.attachmentUploads === true
          ? capabilities.fileAttachments?.maxUploadBytes
          : undefined;
      const maxBytes =
        advertisedMax === undefined ? null : clampFileAttachmentUploadBytes(advertisedMax);
      const wouldExceedInputLimit =
        currentDraft.text.length -
          (currentDraft.text === insertion.text
            ? Math.max(0, insertion.end - insertion.start)
            : 0) +
          result.text.length >
        PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
      const shouldFold =
        pastedTextDisposition({
          text: result.text,
          wouldExceedInputLimit,
          canAttach: true,
        }) === "attachment";
      const canAttach =
        maxBytes !== null &&
        existingQueuedCount + countComposerDraftAttachmentsAfterSelection(threadKey, insertion) <
          PROVIDER_SEND_TURN_MAX_ATTACHMENTS &&
        new TextEncoder().encode(result.text).byteLength <= maxBytes;
      if (shouldFold && canAttach && maxBytes !== null) {
        try {
          const attachment = await createPastedTextComposerAttachment({
            text: result.text,
            name: reservePastedTextFileName(
              threadKey,
              currentAttachments.map((item) => item.name),
            ),
            maxBytes,
          });
          // Same reference the pasted images above get: a folded paste is only visible
          // as its chip until the message is sent.
          if (
            appendComposerDraftAttachments(threadKey, [attachment], {
              appendReference: true,
              insertion,
              maxAttachments,
            }) > 0
          ) {
            await removePersistedComposerAttachmentFile(attachment.fileUri);
            setPendingConnectionError(
              `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
            );
          }
        } catch (error) {
          setPendingConnectionError(
            error instanceof Error ? error.message : "Could not attach pasted text.",
          );
        }
      } else if (shouldFold && !wouldExceedInputLimit) {
        insertComposerDraftText(threadKey, result.text, insertion);
      } else if (shouldFold) {
        setPendingConnectionError(
          wouldExceedInputLimit
            ? "Pasted text is too large for this message. Remove some text or an attachment, then paste again."
            : "Could not attach pasted text. Remove an attachment or use a smaller paste, then try again.",
        );
      } else {
        insertComposerDraftText(threadKey, result.text, insertion);
      }
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    } else if (rejectedPasteCount > 0) {
      setPendingConnectionError(
        `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
      );
    }
  }, [
    composerDrafts,
    reservePastedTextFileName,
    selectedEnvironmentRuntime?.serverConfig,
    selectedThreadShell,
  ]);

  const onNativePasteImages = useCallback(
    async (uris: ReadonlyArray<string>) => {
      if (!selectedThreadShell || uris.length === 0) {
        return;
      }

      const threadKey = activeComposerDraftKey(selectedThreadShell);
      const existingQueuedCount =
        getQueuedRunEdit(scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id))
          ?.existingAttachments.length ?? 0;
      const maxAttachments = Math.max(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS - existingQueuedCount);
      const insertion = captureComposerDraftInsertion(threadKey);
      const existingCount =
        existingQueuedCount + countComposerDraftAttachmentsAfterSelection(threadKey, insertion);
      try {
        const images = await convertPastedImagesToAttachments({ uris, existingCount });
        const droppedBeforeAppend = Math.max(
          0,
          uris.length - Math.max(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS - existingCount),
        );
        const rejectedCount =
          images.length > 0
            ? appendComposerDraftAttachments(threadKey, images, {
                appendReference: true,
                insertion,
                maxAttachments,
              })
            : 0;
        if (rejectedCount > 0 || droppedBeforeAppend > 0) {
          setPendingConnectionError(
            `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
          );
        }
      } catch (error) {
        console.error("[native paste] error converting images", {
          environmentId: selectedThreadShell.environmentId,
          threadId: selectedThreadShell.id,
          uriCount: uris.length,
          ...safeErrorLogAttributes(error),
        });
      }
    },
    [composerDrafts, selectedThreadShell],
  );

  const onNativePasteText = useCallback(
    async (paste: ComposerTextPaste) => {
      if (!selectedThreadShell) return;
      const capabilities = selectedEnvironmentRuntime?.serverConfig?.environment.capabilities;
      const advertisedMax =
        capabilities?.attachmentUploads === true
          ? capabilities.fileAttachments?.maxUploadBytes
          : undefined;
      if (advertisedMax === undefined) return;

      const threadKey = activeComposerDraftKey(selectedThreadShell);
      const existingQueuedCount =
        getQueuedRunEdit(scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id))
          ?.existingAttachments.length ?? 0;
      const maxAttachments = Math.max(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS - existingQueuedCount);
      const insertion = { text: paste.value, ...paste.selection };
      const currentAttachments = getComposerDraftSnapshot(threadKey).attachments;
      try {
        const attachment = await createPastedTextComposerAttachment({
          text: paste.text,
          name: reservePastedTextFileName(
            threadKey,
            currentAttachments.map((item) => item.name),
          ),
          maxBytes: clampFileAttachmentUploadBytes(advertisedMax),
        });
        // The chip is how a folded paste stays visible: without it the attachment is in the
        // draft but nothing in the composer says so until the message is sent. Web folds
        // through its ordinary attach path, which always writes a reference; match that.
        const rejectedCount = appendComposerDraftAttachments(threadKey, [attachment], {
          appendReference: true,
          insertion,
          maxAttachments,
        });
        if (rejectedCount > 0) {
          await removePersistedComposerAttachmentFile(attachment.fileUri);
          setPendingConnectionError(
            `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
          );
        }
      } catch (error) {
        setPendingConnectionError(
          error instanceof Error ? error.message : "Could not attach pasted text.",
        );
      }
    },
    [
      composerDrafts,
      reservePastedTextFileName,
      selectedEnvironmentRuntime?.serverConfig,
      selectedThreadShell,
    ],
  );

  const onRemoveDraftImage = useCallback(
    (imageId: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = activeComposerDraftKey(selectedThreadShell);
      removeComposerDraftAttachment(threadKey, imageId);
    },
    [selectedThreadShell],
  );

  // Existing chat picks are thread commands, independent of the text draft.
  // The shared command scheduler orders a pick before a subsequent send.
  const onUpdateModelSelection = useCallback(
    (value: ModelSelection, options?: { remember?: boolean }) => {
      if (
        !selectedThread ||
        !readEnvironmentScope(selectedThread.environmentId, AuthOrchestrationOperateScope)
      )
        return;
      void pickThreadModel({
        environmentId: selectedThread.environmentId,
        input: {
          threadId: selectedThread.id,
          modelSelection: modelSelectionForDispatch(
            selectedEnvironmentRuntime?.serverConfig,
            value,
          ),
        },
      });
      const provider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
        (candidate) => candidate.instanceId === value.instanceId,
      );
      if (
        provider?.showInteractionModeToggle === false &&
        selectedThread.interactionMode !== "default"
      ) {
        void pickThreadInteractionMode({
          environmentId: selectedThread.environmentId,
          input: { threadId: selectedThread.id, interactionMode: "default" },
        });
      }
      if (options?.remember !== false) setStickyComposerModelSelection(value);
    },
    [
      pickThreadModel,
      pickThreadInteractionMode,
      selectedEnvironmentRuntime?.serverConfig,
      selectedThread,
    ],
  );

  const onUpdateRuntimeMode = useCallback(
    (value: RuntimeMode) => {
      if (
        !selectedThread ||
        !readEnvironmentScope(selectedThread.environmentId, AuthOrchestrationOperateScope)
      )
        return;
      void pickThreadRuntimeMode({
        environmentId: selectedThread.environmentId,
        input: { threadId: selectedThread.id, runtimeMode: value },
      });
    },
    [pickThreadRuntimeMode, selectedThread],
  );

  const onUpdateInteractionMode = useCallback(
    (value: ProviderInteractionMode) => {
      if (
        !selectedThread ||
        !readEnvironmentScope(selectedThread.environmentId, AuthOrchestrationOperateScope)
      )
        return;
      const provider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
        (candidate) => candidate.instanceId === selectedThread.modelSelection.instanceId,
      );
      void pickThreadInteractionMode({
        environmentId: selectedThread.environmentId,
        input: {
          threadId: selectedThread.id,
          interactionMode: resolveProviderInteractionMode(provider, value),
        },
      });
    },
    [pickThreadInteractionMode, selectedEnvironmentRuntime?.serverConfig, selectedThread],
  );

  return {
    feedbackSubmissions,
    dismissFeedback,
    selectedThreadFeed,
    selectedThreadActivityRun,
    selectedThreadQueueCount,
    selectedThreadQueuedMessages,
    dispatchingQueuedMessageId,
    activeWorkStartedAt,
    runlessWorkActive,
    providerSubagentStatus,
    isCompacting,
    draftMessage,
    draftAttachments,
    composerDraftKey,
    followUpBehavior,
    canSteerActiveTurn,
    queuedRunEdit,
    isSavingQueuedEdit,
    cancelQueuedRunEdit,
    onRemoveQueuedEditAttachment,
    modelSelection,
    pendingHandoff,
    canSwitchThreadProvider,
    runtimeMode,
    interactionMode,
    activeThreadBusy,
    interruptibleRunId,
    onChangeDraftMessage,
    onPickDraftMedia,
    onPickDraftFiles,
    onPasteIntoDraft,
    onNativePasteImages,
    onNativePasteText,
    onRemoveDraftImage,
    onSendMessage,
    onUpdateModelSelection,
    onUpdateRuntimeMode,
    onUpdateInteractionMode,
  };
}
