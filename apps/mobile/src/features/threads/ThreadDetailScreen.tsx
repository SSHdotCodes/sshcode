import { useThreadVisit } from "./use-thread-visit";
import { NewChatBackdrop, ThreadEmbers } from "./NewChatBackdrop";
import { chatBackdropMood } from "@t3tools/client-runtime/new-chat-dashboard";
import { useVisibleMinuteClock } from "./use-visible-second-clock";
import { useChatBackdropEnabled } from "./useNewChatDashboard";
import { type TimelineJumpRequest } from "@t3tools/client-runtime/state/thread-search";
import type { ThreadFindAnchorReader } from "./thread-find";
import { ComparisonMembers } from "./ComparisonMembers";
import { discordAvatarIdentity } from "@t3tools/shared/discordProfile";
import type { OrchestrationV2ProviderTurnGeneration, OrchestrationV2Run } from "@t3tools/contracts";
import { CasualVoiceControl } from "../discord/CasualVoiceControl";
import { useCasualVoiceActive, useUiMode } from "../discord/useUiMode";
import { harnessMascotIdentity } from "@t3tools/shared/harnessThemes";
import { DiscordTypingIndicator } from "../discord/DiscordTypingIndicator";
import { modelTraits } from "../../lib/providerOptions";
import { ImageMarkupDraftKey } from "../../components/ImageMarkupContext";
import {
  harnessMascotCompletedTurnDuration,
  harnessMascotAgentId,
} from "@t3tools/shared/harnessMascots";
import {
  HarnessMascotDriver,
  HarnessMascotAgentId,
  HarnessMascotTurnDuration,
} from "../../components/HarnessMascot";
import { useTurnMascotMoments } from "./useTurnMascotState";
import { playThreadFeedback, useThreadFeedback, type ThreadFeedbackRun } from "./useThreadFeedback";
import { prepareMessageQuote } from "./messageQuote";
import { useAtomValue } from "@effect/atom-react";
import { useChildThreadInputs, useThreadReportedModelSelection } from "../../state/entities";
import { UsageLimitRecoveryCard } from "./UsageLimitRecoveryCard";
import { useNavigation } from "@react-navigation/native";
import type { WorktreeSetupCardProps } from "./worktree-setup-card";
import type { ComposerTextPaste } from "../../native/T3ComposerEditor.types";
import { type EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { HandoffEndpoints } from "@t3tools/client-runtime/handoff";
import {
  childThreadInputsTitle,
  type CodexFeedbackSubmission,
  type EnvironmentThreadStatus,
} from "@t3tools/client-runtime/state/threads";
import { useKeyboardChatComposerInset, useKeyboardScrollToEnd } from "@legendapp/list/keyboard";
import { resolveProviderSkillsForCwd } from "@t3tools/client-runtime/providerSkills";
import { useSharedSkillsCatalog } from "../../state/useSharedSkills";
import type { LegendListRef } from "@legendapp/list/react-native";
import { HeaderHeightContext } from "@react-navigation/elements";
import { NativeLayoutObserver } from "../../native/NativeLayoutObserver";
import { deriveBottomControlInsets, type NativeLayoutMetrics } from "../../lib/reserved-regions";
import type {
  EnvironmentId,
  ModelSelection,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  RuntimeMode,
  RuntimeRequestId,
  ScopedThreadRef,
  ServerConfig as T3ServerConfig,
  ThreadId,
  TurnItemId,
  UsageLimitsReport,
} from "@t3tools/contracts";
import type { SteerWait } from "@t3tools/client-runtime/state/steer-wait";
import {
  appendCodexArtifactTemplateUsePrompt,
  type CodexArtifactTemplate,
} from "@t3tools/shared/codexArtifactTemplates";
import type { ThreadUserInputQuestion } from "@t3tools/client-runtime/state/thread-requests";
import {
  presentPendingBackgroundWork,
  presentProviderGoal,
  providerSubagentRelayText,
} from "@t3tools/client-runtime/state/thread-execution";
import { resolveSubagentPillSegment } from "@t3tools/client-runtime/state/thread-subagents";
import {
  formatModelSelectionEffort,
  type ProviderSubagentStatus,
} from "@t3tools/client-runtime/state/thread-execution";
import { formatModelSlugName, resolveSelectableModel } from "@t3tools/shared/model";
import {
  isOrchestrationV2WorkActive,
  isProviderNativeSubagentThread,
  MessageId,
} from "@t3tools/contracts";
import { delegatedChildQuestionIsForParent } from "./delegatedChildQuestion";
import type { QueuedRunEdit } from "../../state/queued-run-edit";
import type { FollowUpBehavior } from "../../lib/followUpBehavior";
import type { ActiveTurnComposerAction } from "@t3tools/client-runtime/state/composer-dispatch";
import * as Haptics from "expo-haptics";
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Alert,
  AppState,
  Keyboard,
  Platform,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
  type ViewInstance,
} from "react-native";
import {
  KeyboardController,
  KeyboardStickyView,
  useKeyboardState,
} from "react-native-keyboard-controller";
import Animated, {
  Easing,
  FadeInDown,
  FadeOut,
  ReduceMotion,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useWorkspaceContentWidth } from "../layout/workspace-content-width";
import { useNativeWorkspaceColumnsSupported } from "../../native/NativeWorkspaceColumns";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { collectProviderUsageLimits } from "@t3tools/shared/usageLimits";
import type { ComposerEditorHandle } from "../../components/ComposerEditor";
import type { StatusTone } from "../../components/StatusPill";
import type { DraftComposerAttachment } from "../../lib/composerImages";
import { RenderErrorBoundary, RenderFailureView } from "../../components/RenderErrorBoundary";
import { CHAT_CONTENT_MAX_WIDTH, type LayoutVariant } from "../../lib/layout";
import { editPendingThreadMessage } from "../../state/edit-pending-thread-message";
import { deviceEnvironment } from "../../state/device";
import { useThreadMonitors } from "./ThreadMonitors";
import { useEnvironmentQuery } from "../../state/query";
import { threadDevicePreviews } from "../devices/threadDevicePreviews";
import { ThreadBrowserFloat } from "../browser/ThreadBrowserFloat";
import { useThreadServerBrowserTabs } from "../../state/preview";
import type { QueuedThreadMessage } from "../../state/thread-outbox-model";
import { scopedThreadKey } from "../../lib/scopedEntities";
import {
  clearThreadComposerError,
  threadComposerErrorsAtom,
} from "../../state/thread-composer-error";
import { threadEnvironment } from "../../state/threads";
import { uuidv4 } from "../../lib/uuid";
import { useAtomCommand } from "../../state/use-atom-command";
import { useDelayedStatus } from "../../lib/useDelayedStatus";
import type {
  PendingApproval,
  PendingUserInput,
  PendingUserInputDraftAnswer,
  ThreadFeedEntry,
  ThreadFeedLatestRun,
} from "../../lib/threadActivity";
import { PendingApprovalCard } from "./PendingApprovalCard";
import { ComposerErrorNotice } from "./ComposerErrorNotice";
import { ComposerFeedback } from "./ComposerFeedback";
import { ComposerUsageLimits, ProviderCreditNotice } from "./ComposerUsageLimits";
import { PendingUserInputCard } from "./PendingUserInputCard";
import { DelegatedQuestionBar } from "./DelegatedQuestionBar";
import { ProviderSubagentBar } from "./ProviderSubagentBar";
import {
  rememberRelayedSubagentMessage,
  useRelayedSubagentMessages,
} from "./relayedSubagentMessages";
import { ThreadCreationFailedCard } from "./ThreadCreationFailedCard";
import {
  FLOATING_WORKING_CONTROL_COVERAGE,
  FloatingWorkingControl,
} from "./floating-working-control";
import {
  backgroundWorkHasAgentsSheetRows,
  connectionFloatingStatus,
  type FloatingWorkingStatus,
} from "./floating-working-status";
import { USER_INPUT_TOGGLE_DURATION_MS, userInputOwnsComposer } from "./pendingUserInputLayout";
import {
  COMPOSER_COLLAPSED_CHROME,
  COMPOSER_EXPANDED_CHROME,
  COMPOSER_LAYOUT_TRANSITION,
  COMPOSER_TRANSITION_DURATION_MS,
  ThreadComposer,
} from "./ThreadComposer";
import { ComposerPopoverHost } from "./ComposerPopoverHost";
import { ThreadFeed, type ThreadFeedHistoryControls } from "./ThreadFeed";
import { useThreadTurnSubagents } from "./ThreadAgentsSheet";
import { ComposerQueuedEditBanner } from "./ComposerQueuedEdit";
import { useThreadQueuedCount, useThreadQueueHeld } from "./ThreadQueueControl";
import type { ThreadContentPresentation } from "./threadContentPresentation";
import { resolveThreadFeedSubmissionAnchor } from "./thread-feed-live-follow";
import { useGlobalVoiceInput } from "../voice-input/VoiceInputProvider";
import { markLoad } from "@t3tools/client-runtime/load-marks";

export interface ThreadDetailScreenProps {
  readonly usageContext?: import("./ThreadUsageRows").ThreadUsageContext | null;
  readonly worktreeSetup?: WorktreeSetupCardProps | null;
  readonly setupWorkingStartedAt?: string | null;
  readonly canOperateThread: boolean;
  readonly selectedThread: EnvironmentThreadShell;
  /**
   * Read thread details through this, not `selectedThread.id`: it stays null until
   * a queued creation reaches the server; see `useThreadSelection`.
   */
  readonly selectedThreadDetailRef: ScopedThreadRef | null;
  readonly contentPresentation: ThreadContentPresentation;
  readonly screenTone: StatusTone;
  readonly connectionError: string | null;
  readonly environmentLabel: string | null;
  readonly feedbackSubmissions: ReadonlyArray<CodexFeedbackSubmission>;
  readonly onDismissFeedback: (id: MessageId) => void;
  readonly selectedThreadFeed: ReadonlyArray<ThreadFeedEntry>;
  readonly mediaJump?: TimelineJumpRequest | null;
  readonly findBar?: import("react").ReactNode;
  readonly findAnchorReader?: import("react").RefObject<ThreadFindAnchorReader | null> | undefined;
  readonly onMediaJumpHandled?: ((sequence: number) => void) | undefined;
  readonly pendingHandoff?: HandoffEndpoints | null;
  readonly activityRun: ThreadFeedLatestRun | null;
  readonly avatarRuns?:
    | ReadonlyArray<Pick<OrchestrationV2Run, "id" | "providerInstanceId" | "modelSelection">>
    | undefined;
  readonly feedbackRuns: ReadonlyArray<ThreadFeedbackRun> | null;
  readonly activeWorkStartedAt: string | null;
  /** The running turn's output speed, shown beside the working time. */
  readonly runningGeneration?: OrchestrationV2ProviderTurnGeneration | undefined;
  /** The live work is a provider-native subagent's runless root turn. */
  readonly runlessWorkActive?: boolean;
  /** Set on a provider-native subagent thread, which shows status instead of a composer. */
  readonly providerSubagentStatus?: ProviderSubagentStatus | null;
  readonly isCompacting: boolean;
  /**
   * The server has not created this thread yet. "preparing" runs while the
   * queued creation is delivered (a worktree may be checking out); "failed"
   * is a rejected creation whose content went back to the project draft.
   * `serverOwned` marks a thread the server already created that is still
   * setting up its worktree; follow-ups queue on the server behind that setup.
   */
  readonly creationState:
    | {
        readonly kind: "preparing";
        readonly preparingWorktree: boolean;
        readonly serverOwned: boolean;
      }
    | { readonly kind: "failed"; readonly reason: string; readonly onEditTask: () => void }
    | null;
  readonly activePendingApproval: PendingApproval | null;
  readonly respondingApprovalId: RuntimeRequestId | null;
  readonly activePendingUserInput: PendingUserInput | null;
  readonly activePendingUserInputQuestionId?: string | null;
  readonly activePendingUserInputDrafts: Record<string, PendingUserInputDraftAnswer>;
  readonly activePendingUserInputAnswers: Record<string, string | ReadonlyArray<string>> | null;
  readonly respondingUserInputId: RuntimeRequestId | null;
  readonly userInputDeliveryStatus?: string | null;
  readonly draftMessage: string;
  readonly draftAttachments: ReadonlyArray<DraftComposerAttachment>;
  readonly connectionStateLabel: EnvironmentConnectionPhase;
  /** Message sync status for the selected thread (drives the composer status pill). */
  readonly threadSyncStatus?: EnvironmentThreadStatus;
  /** Progressive history controls for oversized mobile thread opens. */
  readonly historyControls?: ThreadFeedHistoryControls;
  readonly activeThreadBusy: boolean;
  readonly canStopThread: boolean;
  /** Set while a queued message is open in the composer for editing. */
  readonly queuedRunEdit: QueuedRunEdit | null;
  readonly composerDraftKey: string | null;
  readonly followUpBehavior: FollowUpBehavior;
  readonly canSteerActiveTurn: boolean;
  readonly steerWait?: SteerWait | null;
  readonly onSendSteerNow?: (toolItemIds: ReadonlyArray<TurnItemId>) => Promise<void>;
  readonly isSavingQueuedEdit: boolean;
  readonly onCancelQueuedRunEdit: () => void;
  readonly onRemoveQueuedEditAttachment: (attachmentId: string) => void;
  readonly environmentId: EnvironmentId;
  readonly projectWorkspaceRoot: string | null;
  readonly threadCwd: string | null;
  readonly selectedThreadQueueCount: number;
  readonly queuedMessages: ReadonlyArray<QueuedThreadMessage>;
  readonly dispatchingMessageId: MessageId | null;
  readonly serverConfig: T3ServerConfig | null;
  readonly layoutVariant?: LayoutVariant;
  readonly usesAutomaticContentInsets?: boolean;
  readonly onHeaderMaterialVisibilityChange?: (visible: boolean) => void;
  readonly onOpenConnectionEditor: () => void;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onPickDraftMedia: (source?: "library" | "camera") => Promise<void>;
  readonly onPickDraftFiles: () => Promise<void>;
  readonly onNativePasteImages: (uris: ReadonlyArray<string>) => Promise<void>;
  readonly onNativePasteText: (paste: ComposerTextPaste) => Promise<void>;
  readonly onRemoveDraftImage: (imageId: string) => void;
  readonly onStopThread: () => void;
  readonly onSendMessage: (followUp?: ActiveTurnComposerAction) => Promise<MessageId | null>;
  readonly onReconnectEnvironment: () => void;
  /** Whether the model picker may offer providers other than this thread's. */
  readonly canSwitchThreadProvider: boolean;
  readonly onUpdateThreadModelSelection: (
    modelSelection: ModelSelection,
    options?: { remember?: boolean },
  ) => void;
  readonly onUpdateThreadRuntimeMode: (runtimeMode: RuntimeMode) => void;
  readonly onUpdateThreadInteractionMode: (interactionMode: ProviderInteractionMode) => void;
  readonly onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
  readonly onSelectUserInputOption: (
    requestId: RuntimeRequestId,
    question: ThreadUserInputQuestion,
    value: string,
  ) => void;
  readonly onChangeUserInputCustomAnswer: (
    requestId: RuntimeRequestId,
    questionId: string,
    customAnswer: string,
  ) => void;
  readonly onSubmitUserInput: () => Promise<unknown>;
  readonly onDismissUserInput: () => Promise<unknown>;
  readonly showContent?: boolean;
}

function latestStreamingAssistantMessage(
  feed: ReadonlyArray<ThreadFeedEntry>,
): { readonly id: string; readonly textLength: number } | null {
  for (let index = feed.length - 1; index >= 0; index -= 1) {
    const entry = feed[index];
    if (entry?.type !== "message") {
      continue;
    }
    if (entry.message.role !== "assistant" || !entry.message.streaming) {
      continue;
    }
    return {
      id: entry.message.id,
      textLength: entry.message.text.length,
    };
  }

  return null;
}

function useStreamingHaptics(threadId: ThreadId, feed: ReadonlyArray<ThreadFeedEntry>) {
  const lastStreamingAssistantRef = useRef<{
    readonly id: string;
    readonly textLength: number;
  } | null>(null);
  const lastStreamHapticAtRef = useRef(0);
  const hydratedRef = useRef(false);
  const previousThreadIdRef = useRef(threadId);

  useEffect(() => {
    if (previousThreadIdRef.current !== threadId) {
      previousThreadIdRef.current = threadId;
      hydratedRef.current = false;
    }

    const latestStreamingMessage = latestStreamingAssistantMessage(feed);

    if (!hydratedRef.current) {
      hydratedRef.current = true;
      lastStreamingAssistantRef.current = latestStreamingMessage;
      return;
    }

    if (!latestStreamingMessage) {
      lastStreamingAssistantRef.current = null;
      return;
    }

    const previousStreamingMessage = lastStreamingAssistantRef.current;
    lastStreamingAssistantRef.current = latestStreamingMessage;

    const isNewStream = previousStreamingMessage?.id !== latestStreamingMessage.id;
    const textGrew =
      previousStreamingMessage?.id === latestStreamingMessage.id &&
      latestStreamingMessage.textLength > previousStreamingMessage.textLength;

    if (!isNewStream && !textGrew) {
      return;
    }

    const now = Date.now();
    if (!isNewStream && now - lastStreamHapticAtRef.current < 320) {
      return;
    }

    lastStreamHapticAtRef.current = now;
    void Haptics.selectionAsync();
  }, [threadId, feed]);
}

const USER_INPUT_TOGGLE_TIMING = {
  duration: USER_INPUT_TOGGLE_DURATION_MS,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
};
const DETAIL_CARD_EASING = Easing.out(Easing.cubic);
const DETAIL_CARD_ENTER_QUICK = FadeInDown.duration(180)
  .easing(DETAIL_CARD_EASING)
  .reduceMotion(ReduceMotion.System);
const DETAIL_CARD_EXIT_QUICK = FadeOut.duration(120).reduceMotion(ReduceMotion.System);
const DETAIL_CARD_ENTER = FadeInDown.duration(200)
  .easing(DETAIL_CARD_EASING)
  .reduceMotion(ReduceMotion.System);
const DETAIL_CARD_EXIT = FadeOut.duration(130).reduceMotion(ReduceMotion.System);

export const ThreadDetailScreen = memo(function ThreadDetailScreen(props: ThreadDetailScreenProps) {
  const usesNativeWorkspaceColumns = useNativeWorkspaceColumnsSupported();
  const navigation = useNavigation();
  const { session: voiceInputSession } = useGlobalVoiceInput();
  const reportedModelSelection = useThreadReportedModelSelection(props.selectedThreadDetailRef);
  const deviceState = useEnvironmentQuery(
    deviceEnvironment.state({ environmentId: props.environmentId, input: {} }),
  );
  const devicePreviews = useMemo(
    () => threadDevicePreviews(deviceState.data, props.selectedThread.id),
    [deviceState.data, props.selectedThread.id],
  );
  const openDevicePreview = useCallback(() => {
    Keyboard.dismiss();
    navigation.navigate("ThreadDevicePreview", {
      environmentId: props.environmentId,
      threadId: props.selectedThread.id,
    });
  }, [navigation, props.environmentId, props.selectedThread.id]);
  const browserTabs = useThreadServerBrowserTabs({
    environmentId: props.environmentId,
    threadId: props.selectedThread.id,
    enabled: props.serverConfig?.environment.capabilities.serverBrowser === true,
  });
  const openBrowserPreview = useCallback(
    (tabId?: string) => {
      Keyboard.dismiss();
      navigation.navigate("ThreadBrowserPreview", {
        environmentId: props.environmentId,
        threadId: props.selectedThread.id,
        ...(tabId === undefined ? {} : { tabId }),
      });
    },
    [navigation, props.environmentId, props.selectedThread.id],
  );
  const insets = useSafeAreaInsets();
  const isKeyboardVisible = useKeyboardState((state) => state.isVisible);
  const liveKeyboardHeight = useKeyboardState((state) => state.height);
  // Android can swallow the IME hide callbacks when the app is backgrounded
  // mid keyboard-hide (the reported repro: send — which blurs and starts the
  // hide — then Home within a second). The keyboard library's height AND
  // visibility then stay frozen open, so gating the sticky translation on
  // visibility alone still strands the composer after resume. Quarantine the
  // translation on every Android resume instead; any sign of a live keyboard
  // stream — an owned input gaining focus, or any visibility/height movement —
  // lifts it. A healthy resume sees no visual difference (the translation is
  // already zero while the keyboard is closed).
  const [keyboardStateSuspect, setKeyboardStateSuspect] = useState(false);
  const activeUserInputRequestId = props.activePendingUserInput?.requestId ?? null;
  const [focusedUserInputRequestId, setFocusedUserInputRequestId] =
    useState<RuntimeRequestId | null>(null);
  const ownedInputFocused =
    activeUserInputRequestId !== null && focusedUserInputRequestId === activeUserInputRequestId;
  useEffect(() => {
    if (Platform.OS !== "android") {
      return;
    }
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        setKeyboardStateSuspect(true);
      }
    });
    return () => {
      subscription.remove();
    };
  }, []);
  useEffect(() => {
    setKeyboardStateSuspect(false);
  }, [isKeyboardVisible, liveKeyboardHeight]);
  const handleOwnedInputFocusChange = useCallback(
    (focused: boolean) => {
      setFocusedUserInputRequestId(focused ? activeUserInputRequestId : null);
      if (focused) {
        setKeyboardStateSuspect(false);
      }
    },
    [activeUserInputRequestId],
  );
  const windowHeight = useWindowDimensions().height;
  const navigationHeaderHeight = useContext(HeaderHeightContext) ?? insets.top + 44;
  const [screenMetrics, setScreenMetrics] = useState<NativeLayoutMetrics | null>(null);
  const columnMetrics = useNativeColumnLayoutMetrics();
  const nativeMetrics = usesNativeWorkspaceColumns ? columnMetrics : screenMetrics;
  const controlInsets = deriveBottomControlInsets(nativeMetrics);
  const [uiMode] = useUiMode();
  const discord = uiMode === "discord";
  const casualVoice = useCasualVoiceActive();
  const agentProvider = props.serverConfig?.providers.find(
    (provider) => provider.instanceId === props.selectedThread.modelSelection.instanceId,
  );
  const agentLabel = agentProvider?.displayName ?? agentProvider?.driver ?? "Agent";
  const selectedThreadKey = scopedThreadKey(props.environmentId, props.selectedThread.id);
  const [rewinding, setRewinding] = useState(false);
  const childThreadInputs = useChildThreadInputs({
    environmentId: props.environmentId,
    threadId: props.selectedThread.id,
  });
  const composerErrorRecord = useAtomValue(threadComposerErrorsAtom)[selectedThreadKey] ?? null;
  const composerError = composerErrorRecord?.message ?? null;
  useThreadFeedback(selectedThreadKey, props.feedbackRuns, composerErrorRecord, {
    syncStatus: props.threadSyncStatus ?? "empty",
    connected: props.connectionStateLabel === "connected",
    visible: props.showContent !== false,
    supportsSyncMarker: props.serverConfig?.threadResumeCompletionMarker === true,
    pendingRequestId: props.activePendingUserInput?.requestId ?? null,
  });
  const queuedCount = useThreadQueuedCount(props.selectedThreadDetailRef);
  const queueHeld = useThreadQueueHeld(props.selectedThreadDetailRef);
  const turnSubagents = useThreadTurnSubagents(props.selectedThreadDetailRef);
  const composerEditorRef = useRef<ComposerEditorHandle>(null);
  // A provider-native subagent shows status instead of a composer.
  const isProviderSubagent = isProviderNativeSubagentThread(props.selectedThread.source);
  // A delegated child's question goes to its parent agent. The child thread
  // must not offer a reply field for it.
  const parentAnswersQuestion =
    props.activePendingUserInput !== null &&
    delegatedChildQuestionIsForParent(props.selectedThread.source);
  // Entering edit mode from the queue sheet should land in a ready composer,
  // not require a second tap on a composer already holding the message.
  const editingRunId = props.queuedRunEdit?.runId ?? null;
  useEffect(() => {
    if (editingRunId === null) return;
    const frame = requestAnimationFrame(() => composerEditorRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [editingRunId]);
  const draftMessageRef = useRef(props.draftMessage);
  draftMessageRef.current = props.draftMessage;
  const composerOverlayRef = useRef<ViewInstance>(null);
  const listRef = useRef<LegendListRef>(null);
  const feedTouchStartRef = useRef<{ pageX: number; pageY: number } | null>(null);
  const selectedThreadKeyRef = useRef(selectedThreadKey);
  const lastScrolledSubmittedMessageIdRef = useRef<MessageId | null>(null);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const handleComposerFocusChange = useCallback(
    (focused: boolean) => {
      setComposerFocused(focused);
      handleOwnedInputFocusChange(focused);
    },
    [handleOwnedInputFocusChange],
  );
  const [anchorMessageId, setAnchorMessageId] = useState<MessageId | null>(null);
  const [submittedMessageId, setSubmittedMessageId] = useState<MessageId | null>(null);
  const [endFollowEnabled, setEndFollowEnabled] = useState(true);
  // Android keys the safe-area padding on keyboard visibility (#5988): the
  // back gesture closes the keyboard while the editor stays focused, and a
  // focus-keyed inset would leave the toolbar under the gesture bar. iOS must
  // NOT use visibility — it only flips on keyboardDidHide, after the hide
  // animation, so the composer would ride down flush to the screen edge and
  // then snap up into the inset. On iOS blur precedes the hide, so the
  // focus-keyed inset is already in place while the composer rides down.
  // Dictation keeps that focus while the composer switches to its compact pill.
  // Attachments can expand an unfocused composer, which still needs to clear the tabs.
  const composerBottomInset = (
    Platform.OS === "android" ? isKeyboardVisible : composerFocused || ownedInputFocused
  )
    ? 0
    : Math.max(insets.bottom, 12);
  const contentPresentationKind = props.contentPresentation.kind;
  // The raw sync status enters "synchronizing" on every full fetch, cached or
  // not. Whether messages are already on screen decides the pill label: no
  // data yet → "Loading messages", cached data reconciling → "Syncing".
  const realThreadSyncLabel = (() => {
    switch (props.threadSyncStatus) {
      case "empty":
      case "cached":
      case "synchronizing":
        if (contentPresentationKind === "ready") {
          return "Syncing messages...";
        }
        return contentPresentationKind === "loading" ? "Loading messages..." : null;
      default:
        return null;
    }
  })();
  // Opening a running thread resyncs for a few frames. The pill shows the
  // sync label only when the sync lasts, so it does not flash before the timer.
  const threadSyncLabel = useDelayedStatus(selectedThreadKey, realThreadSyncLabel);
  const showLoadingPlaceholder =
    !discord &&
    !props.worktreeSetup &&
    props.queuedMessages.length === 0 &&
    contentPresentationKind === "loading" &&
    threadSyncLabel !== null;
  const connectionRetrying =
    props.connectionStateLabel === "connecting" || props.connectionStateLabel === "reconnecting";
  const retryError = connectionRetrying ? props.connectionError : null;
  // Failures survive retries and app suspension. Give a returning phone time
  // to reconnect before presenting the previous attempt as a fresh failure.
  const retryConnectionError = useDelayedStatus(
    `${props.environmentId}:${retryError !== null}`,
    retryError,
    5_000,
  );
  // What the user sees: messages on screen, then the sync pill gone.
  const markedThreadId = props.selectedThread.id.slice(0, 8);
  const markedEnvironmentId = props.environmentId.slice(0, 8);
  useEffect(() => {
    if (contentPresentationKind === "ready")
      markLoad("ui.thread.ready", { thread: markedThreadId, environment: markedEnvironmentId });
  }, [contentPresentationKind, markedThreadId, markedEnvironmentId]);
  const threadSynced = realThreadSyncLabel === null;
  useEffect(() => {
    markLoad(threadSynced ? "ui.thread.synced" : "ui.thread.syncing", {
      thread: markedThreadId,
      environment: markedEnvironmentId,
    });
  }, [threadSynced, markedThreadId, markedEnvironmentId]);
  // One floating pill above the composer: it reads the connection phase while
  // disconnected, the sync state while messages load, then the working timer
  // once the feed is settled.
  // The shell's roster is the server's post-settlement view of what still runs.
  // App-owned monitors wake the agent too, so they join it in the pill; their
  // Stop buttons live in the Agents sheet the pill opens.
  const threadMonitors = useThreadMonitors(props.environmentId, props.selectedThread.id);
  const pendingBackgroundWork = presentPendingBackgroundWork([
    ...props.selectedThread.pendingBackgroundTasks,
    ...threadMonitors.map((monitor) => ({
      taskId: `app-monitor:${monitor.monitorId}`,
      kind: "monitor" as const,
      description: monitor.state
        ? `${monitor.description} (${monitor.state})`
        : monitor.description,
    })),
  ]);
  const heldTaskIds = new Set(
    pendingBackgroundWork?.items
      .filter((item) => item.held !== undefined)
      .map((item) => item.taskId.replace(/^turn-item:/, "node:")),
  );
  const visibleAgents = turnSubagents?.subagents.filter((agent) => !heldTaskIds.has(agent.id));
  const agentsSegment = resolveSubagentPillSegment(
    turnSubagents === null || visibleAgents === undefined || visibleAgents.length === 0
      ? null
      : {
          ...turnSubagents,
          subagents: visibleAgents,
          liveCount: visibleAgents.filter((agent) => isOrchestrationV2WorkActive(agent.status))
            .length,
        },
  );
  const openAgentsSheet = () => {
    Keyboard.dismiss();
    navigation.navigate("ThreadAgents", {
      environmentId: props.environmentId,
      threadId: props.selectedThread.id,
    });
  };
  const floatingStatus = ((): FloatingWorkingStatus | null => {
    const connectionStatus = connectionFloatingStatus({
      connectionError: connectionRetrying ? retryConnectionError : props.connectionError,
      connectionState: props.connectionStateLabel,
      environmentLabel: props.environmentLabel,
      onReconnect: props.onReconnectEnvironment,
    });
    if (connectionStatus !== null) {
      return connectionStatus;
    }
    if (props.activePendingApproval !== null || props.activePendingUserInput !== null) {
      return null;
    }
    if (props.creationState?.kind === "preparing") {
      // The setup header already reports progress in the feed.
      if (props.worktreeSetup) return null;
      return {
        kind: "preparing",
        label: props.creationState.preparingWorktree ? "Setting up worktree…" : "Starting…",
      };
    }
    if (props.creationState?.kind === "failed") {
      return null;
    }
    if (threadSyncLabel !== null) {
      return { kind: "syncing", label: threadSyncLabel, showSpinner: !showLoadingPlaceholder };
    }
    const childInput = childThreadInputs[0];
    if (childInput && contentPresentationKind === "ready") {
      return {
        kind: "child-input",
        label: childThreadInputsTitle(childThreadInputs),
        accessibilityLabel: `Open ${childInput.hasPendingApprovals ? "approval" : "question"} from ${childInput.title}`,
        onPress: () => {
          Keyboard.dismiss();
          navigation.navigate("Thread", {
            environmentId: props.environmentId,
            threadId: childInput.id,
          });
        },
      };
    }
    if (props.isCompacting && contentPresentationKind === "ready") {
      return { kind: "compacting" };
    }
    if (props.activeWorkStartedAt !== null && contentPresentationKind === "ready") {
      return {
        kind: "working",
        startedAt: props.activeWorkStartedAt,
        ...(props.runningGeneration === undefined ? {} : { generation: props.runningGeneration }),
      };
    }
    if (pendingBackgroundWork !== null && contentPresentationKind === "ready") {
      return {
        kind: "background",
        label: pendingBackgroundWork.title,
        accessibilityLabel: `${pendingBackgroundWork.title}: ${pendingBackgroundWork.items
          .map((item) => item.label)
          .join(", ")}`,
        waiting: pendingBackgroundWork.waiting,
        running: pendingBackgroundWork.running,
        ...(pendingBackgroundWork.items.length === 1 &&
        pendingBackgroundWork.items[0]?.held !== undefined
          ? { held: { environmentId: props.environmentId, item: pendingBackgroundWork.items[0] } }
          : {}),
        // Commands and background tasks have no row in the sheet, so a roster
        // of just those keeps the pill informational; its label names them.
        ...(backgroundWorkHasAgentsSheetRows(pendingBackgroundWork.items)
          ? { onPress: openAgentsSheet }
          : {}),
      };
    }
    if (props.selectedThread.goal !== null && contentPresentationKind === "ready") {
      const goal = presentProviderGoal(props.selectedThread.goal, false);
      return {
        kind: "goal",
        label: goal.title,
        accessibilityLabel: `${goal.title}: ${goal.objective}`,
      };
    }
    return null;
  })();
  const { state: mascotState, moment: mascotMoment } = useTurnMascotMoments(
    `${props.environmentId}:${props.selectedThread.id}`,
    props.activeWorkStartedAt !== null,
    props.activePendingApproval !== null || props.activePendingUserInput !== null,
    props.activityRun?.status,
    props.activityRun?.runId,
  );
  const showWorkingControl = floatingStatus !== null;
  // Mascot reactions also draw a capsule when the working status is gone.
  // Reserve the same pill height and gap until that reaction disappears.
  const showFloatingStatus =
    showWorkingControl ||
    mascotState === "done" ||
    mascotState === "failed" ||
    (mascotMoment !== null && mascotMoment.kind !== "waiting") ||
    queuedCount > 0 ||
    agentsSegment !== null ||
    devicePreviews.length > 0 ||
    browserTabs.tabs.length > 0 ||
    props.connectionStateLabel !== "connected" ||
    props.queuedMessages.length > 0 ||
    props.selectedThreadFeed.some(
      (entry) => "acknowledged" in entry && entry.acknowledged === true,
    );
  const selectedThreadFeed = props.selectedThreadFeed;
  const hasCompactableConversation =
    selectedThreadFeed.some(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "user" &&
        ((entry.message.attachments?.length ?? 0) > 0 ||
          entry.message.text.trim().toLowerCase() !== "/compact"),
    ) ||
    (props.historyControls?.hasMoreHistory === true &&
      props.selectedThread.latestUserMessageAt !== null);
  const composerChrome = composerExpanded ? COMPOSER_EXPANDED_CHROME : COMPOSER_COLLAPSED_CHROME;
  const composerOverlapHeight = composerChrome + composerBottomInset;
  // Collapse state belongs to a request; a new question reopens its card.
  const [collapsedUserInputRequestId, setCollapsedUserInputRequestId] =
    useState<RuntimeRequestId | null>(null);
  // Questions keep the existing editor mounted and visible so typing and
  // selection survive their arrival. A failed creation still owns the slot.
  const userInputOwnsComposerSlot = userInputOwnsComposer(props.activePendingUserInput);
  // A delegated child's question hides the composer, and the status bar takes
  // that slot even when the question would otherwise own it.
  const composerSlotHidden = props.creationState?.kind === "failed";
  // The open /usage-limits panel for this thread, model and turn. Only the open
  // moment is stored: the rows read live provider data, so a redeemed reset
  // credit or refreshed probe shows through. Anything that spends quota closes
  // it: a new turn from any source, or the agent resuming after an approval or
  // answered question.
  const [usageLimitsPanel, setUsageLimitsPanel] = useState<{
    readonly key: string;
    readonly threadKey: string;
  } | null>(null);
  const usageLimitsNow = useVisibleMinuteClock(usageLimitsPanel !== null);
  // A pending approval or question is part of the key: once it is answered,
  // from this client or any other, the agent resumes and spends quota.
  const usageLimitsKey = [
    selectedThreadKey,
    props.selectedThread.modelSelection.instanceId,
    props.selectedThread.latestRun?.runId ?? "",
    props.activePendingApproval?.requestId ?? props.activePendingUserInput?.requestId ?? "",
  ].join(":");
  // Drop the snapshot as soon as the key changes so it cannot resurface stale.
  if (usageLimitsPanel !== null && usageLimitsPanel.key !== usageLimitsKey) {
    setUsageLimitsPanel(null);
  }
  const usageLimitsReport = useMemo(
    () =>
      usageLimitsPanel !== null && usageLimitsPanel.key === usageLimitsKey
        ? collectProviderUsageLimits(
            props.selectedThread.modelSelection.instanceId,
            props.serverConfig?.providers ?? [],
            props.serverConfig?.usageLimitSources ?? [],
            usageLimitsNow,
          )
        : null,
    [
      props.selectedThread.modelSelection.instanceId,
      props.serverConfig,
      usageLimitsKey,
      usageLimitsPanel,
      usageLimitsNow,
    ],
  );
  const showUsageLimits = useCallback(
    (report: UsageLimitsReport | null) =>
      setUsageLimitsPanel(
        report === null
          ? null
          : {
              key: usageLimitsKey,
              threadKey: selectedThreadKey,
            },
      ),
    [selectedThreadKey, usageLimitsKey],
  );
  const dismissUsageLimits = useCallback(() => setUsageLimitsPanel(null), []);
  // A send may resolve after navigating away, so only the originating
  // thread's panel is cleared; a panel opened elsewhere in the meantime stays.
  const clearUsageLimitsFor = useCallback(
    (threadKey: string) =>
      setUsageLimitsPanel((current) =>
        current !== null && current.threadKey === threadKey ? null : current,
      ),
    [],
  );
  const userInputCollapsed =
    activeUserInputRequestId !== null && collapsedUserInputRequestId === activeUserInputRequestId;
  const pendingUserInputHeightConstraints = {
    windowHeight,
    navigationHeaderHeight,
    composerOverlapHeight,
  };
  const estimatedOverlayHeight = composerOverlapHeight;
  // The overlay's measured height includes the home-indicator inset (the
  // composer pads it), but contentInsetAdjustmentBehavior="automatic" makes
  // UIKit add the safe-area bottom to the content inset AGAIN — leaving a
  // dead strip between the resting content and the composer. Report the
  // overlay height minus the safe area; UIKit adds it back, and ThreadFeed
  // hands LegendList the same delta via contentInsetEndStaticAdjustment so
  // its end-scroll math matches the real resting position.
  const nativeInsetOvercount =
    props.usesAutomaticContentInsets === true && Platform.OS === "ios" ? insets.bottom : 0;
  const { contentInsetEndAdjustment, onComposerLayout } = useKeyboardChatComposerInset(
    listRef,
    composerOverlayRef,
    Math.max(0, estimatedOverlayHeight - nativeInsetOvercount),
    -nativeInsetOvercount,
    Platform.OS === "ios" ? COMPOSER_TRANSITION_DURATION_MS : 0,
  );
  // The expanded questionnaire is an absolute overlay on iOS, so it never
  // changes the measured overlay height (that constancy is what keeps the
  // feed from snapping on collapse/expand). The toggle choreography runs on
  // SHARED VALUES set directly in the tap handler — one JS hop, then the
  // card's rise/sink and the feed's end-inset glide animate in lockstep on
  // the UI thread, keyboard-style, instead of waiting on React mount +
  // onLayout + state round trips. Coverage (how far the card extends above
  // the bar) is measured straight into a shared value by the card's
  // onLayout, with no re-render.
  const userInputCardProgress = useSharedValue(1);
  const userInputInsetProgress = useSharedValue(1);
  const userInputCardCoverage = useSharedValue(0);
  const floatingControlCoverage = useSharedValue(
    showFloatingStatus ? FLOATING_WORKING_CONTROL_COVERAGE : 0,
  );
  useEffect(() => {
    floatingControlCoverage.value = withTiming(
      showFloatingStatus ? FLOATING_WORKING_CONTROL_COVERAGE : 0,
      { duration: 180, reduceMotion: ReduceMotion.System },
    );
  }, [floatingControlCoverage, showFloatingStatus]);
  // Android renders the expanded card in-flow (it cannot hit-test the iOS
  // overlay outside the bar's bounds), so its measured overlay height already
  // includes the card — the coverage extra is iOS-only.
  const userInputCoverageApplies = Platform.OS === "ios" && activeUserInputRequestId !== null;
  const combinedContentInsetEndAdjustment = useSharedValue(
    Math.max(0, estimatedOverlayHeight - nativeInsetOvercount),
  );
  useAnimatedReaction(
    () =>
      contentInsetEndAdjustment.value +
      floatingControlCoverage.value +
      (userInputCoverageApplies ? userInputInsetProgress.value * userInputCardCoverage.value : 0),
    (value) => {
      combinedContentInsetEndAdjustment.value = value;
    },
    [userInputCoverageApplies],
  );
  // The floating control is anchored to the bar's top edge, so ride it up
  // with the expanded card instead of drawing it over the questions.
  const floatingControlLift = useDerivedValue(
    () =>
      userInputCoverageApplies ? userInputCardProgress.value * userInputCardCoverage.value : 0,
    [userInputCoverageApplies],
  );
  const { freeze, scrollMessageToEnd } = useKeyboardScrollToEnd({ listRef });
  const endFollowEnabledRef = useRef(true);
  endFollowEnabledRef.current = endFollowEnabled;
  const overlayRepinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousWorkingControlStateRef = useRef({
    threadKey: selectedThreadKey,
    visible: false,
  });
  // The list's own corrections for these inset changes drift on short
  // content (and the error compounds across toggles), so deterministically
  // re-pin the end once a toggle settles: a no-op when the resting position
  // is already right, corrective when it is not. Follow state is re-checked
  // inside the callback — the user may grab the list during the settle
  // window, and yanking them back would override a live gesture.
  const scheduleOverlayRepin = useCallback(
    (delayMs: number) => {
      if (overlayRepinTimerRef.current !== null) {
        clearTimeout(overlayRepinTimerRef.current);
      }
      overlayRepinTimerRef.current = setTimeout(() => {
        overlayRepinTimerRef.current = null;
        if (!endFollowEnabledRef.current) {
          return;
        }
        void scrollMessageToEnd({ animated: false, closeKeyboard: false }).catch(() => {
          freeze.set(false);
        });
      }, delayMs);
    },
    [freeze, scrollMessageToEnd],
  );
  useEffect(
    () => () => {
      if (overlayRepinTimerRef.current !== null) {
        clearTimeout(overlayRepinTimerRef.current);
      }
    },
    [],
  );
  useEffect(() => {
    const previous = previousWorkingControlStateRef.current;
    const threadChanged = previous.threadKey !== selectedThreadKey;
    const visibilityChanged = previous.visible !== showFloatingStatus;
    previousWorkingControlStateRef.current = {
      threadKey: selectedThreadKey,
      visible: showFloatingStatus,
    };
    if ((!threadChanged && !visibilityChanged) || (threadChanged && !showFloatingStatus)) {
      return;
    }
    // LegendList applies the larger inset but does not re-anchor short
    // followed conversations when this floating coverage changes after the
    // initial load. Re-pin after the finite inset transition; the callback
    // checks follow state again so a user who scrolled up stays put.
    scheduleOverlayRepin(230);
  }, [scheduleOverlayRepin, selectedThreadKey, showFloatingStatus]);
  // Same for the question card: opening a chat onto a waiting question, its first
  // measurement can land after the end-pin, leaving the agent's last reply behind it.
  useAnimatedReaction(
    () => userInputCoverageApplies && userInputCardCoverage.value > 0,
    (covered, previous) => {
      if (covered && previous !== true) runOnJS(scheduleOverlayRepin)(60);
    },
    [scheduleOverlayRepin, userInputCoverageApplies],
  );
  const handleToggleUserInputCollapsed = useCallback(() => {
    if (activeUserInputRequestId === null) {
      return;
    }
    void Promise.resolve(Haptics.selectionAsync()).catch(() => undefined);
    if (userInputCollapsed) {
      // Expanding: card and feed glide start NOW, on the UI thread.
      userInputCardProgress.value = withTiming(1, USER_INPUT_TOGGLE_TIMING);
      userInputInsetProgress.value = withTiming(1, USER_INPUT_TOGGLE_TIMING);
      setCollapsedUserInputRequestId(null);
      scheduleOverlayRepin(USER_INPUT_TOGGLE_DURATION_MS + 50);
    } else {
      setFocusedUserInputRequestId(null);
      // Collapsing hides the custom-answer inputs; release the keyboard with
      // them instead of leaving it up over a dead responder.
      Keyboard.dismiss();
      userInputCardProgress.value = withTiming(0, USER_INPUT_TOGGLE_TIMING);
      // Instant: the sinking card still covers the strip being revealed, and
      // animating the inset downward is what drifted the short-content end
      // anchor.
      userInputInsetProgress.value = 0;
      setCollapsedUserInputRequestId(activeUserInputRequestId);
      scheduleOverlayRepin(60);
    }
  }, [
    activeUserInputRequestId,
    scheduleOverlayRepin,
    userInputCardProgress,
    userInputCollapsed,
    userInputInsetProgress,
  ]);
  useEffect(() => {
    // A new request always arrives expanded.
    userInputCardProgress.value = 1;
    userInputInsetProgress.value = 1;
  }, [activeUserInputRequestId, userInputCardProgress, userInputInsetProgress]);
  const showContent = props.showContent ?? true;
  const layoutVariant = props.layoutVariant ?? "compact";
  const isSplitLayout = layoutVariant === "split";
  const contentMaxWidth = isSplitLayout ? CHAT_CONTENT_MAX_WIDTH : undefined;
  const providerSubagentProvider = props.serverConfig?.providers.find(
    (provider) => provider.instanceId === props.selectedThread.modelSelection.instanceId,
  );
  const agentAvatars = useMemo(
    () =>
      discord
        ? new Map(
            (props.avatarRuns ?? []).map((run) => {
              const provider = props.serverConfig?.providers.find(
                (candidate) => candidate.instanceId === run.providerInstanceId,
              );
              return [
                run.id,
                discordAvatarIdentity({
                  driver: provider?.driver,
                  instanceId: run.providerInstanceId,
                  model: run.modelSelection.model,
                  agentId: harnessMascotAgentId(
                    provider?.driver,
                    provider
                      ? props.serverConfig?.settings.providerInstances[provider.instanceId]?.config
                      : null,
                  ),
                }),
              ];
            }),
          )
        : undefined,
    [discord, props.avatarRuns, props.serverConfig],
  );
  const [chatBackdropEnabled] = useChatBackdropEnabled();
  const threadMascot = harnessMascotIdentity({
    driver: providerSubagentProvider?.driver ?? null,
    instanceId: props.selectedThread.modelSelection.instanceId,
    model: props.selectedThread.modelSelection.model,
    agentId: harnessMascotAgentId(
      providerSubagentProvider?.driver,
      providerSubagentProvider
        ? props.serverConfig?.settings.providerInstances[providerSubagentProvider.instanceId]
            ?.config
        : null,
    ),
  });
  // Providers can report a dated id or alias (claude-haiku-4-5-20251001).
  const providerSubagentModelSlug = providerSubagentProvider
    ? resolveSelectableModel(
        providerSubagentProvider.driver,
        props.selectedThread.modelSelection.model,
        providerSubagentProvider.models,
      )
    : null;
  const providerSubagentCatalogModel = providerSubagentProvider?.models.find(
    (model) => model.slug === providerSubagentModelSlug,
  );
  const workspaceContentWidth = useWorkspaceContentWidth();
  // Clearing animated width can retain the unfolded width after Android resumes folded.
  // Assign both layouts explicitly so the dock always follows its current parent.
  const composerWidthStyle = useAnimatedStyle(() =>
    isSplitLayout && workspaceContentWidth !== null
      ? {
          width: Math.max(
            0,
            workspaceContentWidth.value - controlInsets.left - controlInsets.right,
          ),
          right: undefined,
        }
      : { width: undefined, right: controlInsets.right },
  );
  const selectedInstanceId = props.selectedThread.modelSelection.instanceId;
  useStreamingHaptics(props.selectedThread.id, props.selectedThreadFeed);
  const sharedSkills = useSharedSkillsCatalog(props.environmentId);
  const selectedProviderSkills = useMemo(() => {
    const provider = props.serverConfig?.providers.find(
      (candidate) => candidate.instanceId === selectedInstanceId,
    );
    return provider
      ? resolveProviderSkillsForCwd(provider, props.threadCwd ?? props.projectWorkspaceRoot, {
          catalog: sharedSkills,
          agentId: harnessMascotAgentId(
            provider.driver,
            props.serverConfig?.settings.providerInstances[provider.instanceId]?.config,
          ),
        })
      : [];
  }, [
    props.projectWorkspaceRoot,
    props.serverConfig,
    props.threadCwd,
    selectedInstanceId,
    sharedSkills,
  ]);

  useLayoutEffect(() => {
    selectedThreadKeyRef.current = selectedThreadKey;
    // A replaced or unmounted native editor may not emit a blur event.
    setComposerFocused(false);
  }, [selectedThreadKey, showContent]);

  const visitThread = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  // The provider runs a native subagent, so its parent passes a message on,
  // steering in when it's working, as a typed message would.
  const startParentTurn = useAtomCommand(threadEnvironment.startTurn, "send to the subagent");
  const subagentParentThreadId = props.selectedThread.lineage.parentThreadId;
  const subagentParentEnvironmentId =
    props.selectedThread.lineage.parentEnvironmentId ?? props.environmentId;
  const sendThroughParent = useCallback(
    async (text: string) => {
      if (subagentParentThreadId === null) return false;
      const result = await startParentTurn({
        environmentId: subagentParentEnvironmentId,
        input: {
          threadId: subagentParentThreadId,
          message: {
            messageId: MessageId.make(uuidv4()),
            role: "user",
            text: providerSubagentRelayText(props.selectedThread.title, text),
            attachments: [],
          },
          runtimeMode: props.selectedThread.runtimeMode,
          interactionMode: props.selectedThread.interactionMode,
          dispatchMode: "auto",
        },
      });
      if (result._tag !== "Success") return false;
      rememberRelayedSubagentMessage(props.selectedThread.id, text);
      return true;
    },
    [
      subagentParentEnvironmentId,
      props.selectedThread.id,
      props.selectedThread.interactionMode,
      props.selectedThread.runtimeMode,
      props.selectedThread.title,
      startParentTurn,
      subagentParentThreadId,
    ],
  );
  const relayedSubagentMessages = useRelayedSubagentMessages(
    isProviderSubagent ? props.selectedThread.id : null,
  );
  const selectedThreadId = props.selectedThread.id;
  const selectedThreadUpdatedAt = props.selectedThread.updatedAt;
  const selectedThreadLastVisitedAt = props.selectedThread.lastVisitedAt;
  const [openVisit, setOpenVisit] = useState({
    key: selectedThreadKey,
    at: selectedThreadLastVisitedAt,
  });
  if (openVisit.key !== selectedThreadKey) {
    setOpenVisit({ key: selectedThreadKey, at: selectedThreadLastVisitedAt });
  }
  const visitedAtOpen =
    openVisit.key === selectedThreadKey ? openVisit.at : selectedThreadLastVisitedAt;
  const selectedThreadCompletedAt = props.selectedThread.latestRun?.completedAt;
  useThreadVisit({
    environmentId: props.environmentId,
    threadId: selectedThreadId,
    threadKey: selectedThreadKey,
    updatedAt: selectedThreadUpdatedAt,
    lastVisitedAt: selectedThreadLastVisitedAt,
    completedAt: selectedThreadCompletedAt,
    showContent,
    visitThread,
  });

  useEffect(() => {
    setAnchorMessageId(null);
    setSubmittedMessageId(null);
    lastScrolledSubmittedMessageIdRef.current = null;
    setEndFollowEnabled(true);
    freeze.set(false);
  }, [freeze, selectedThreadKey]);

  useEffect(() => {
    if (
      submittedMessageId === null ||
      anchorMessageId !== submittedMessageId ||
      lastScrolledSubmittedMessageIdRef.current === submittedMessageId ||
      contentPresentationKind !== "ready" ||
      (!selectedThreadFeed.some(
        (entry) => entry.type === "message" && entry.id === submittedMessageId,
      ) &&
        !props.queuedMessages.some((message) => message.messageId === submittedMessageId))
    ) {
      return;
    }

    const targetThreadKey = selectedThreadKey;
    const frame = requestAnimationFrame(() => {
      if (selectedThreadKeyRef.current !== targetThreadKey) {
        return;
      }
      lastScrolledSubmittedMessageIdRef.current = submittedMessageId;
      // Wait for the keyboard dismissal (started by blur() on send) to finish
      // before scrolling: scrollMessageToEnd freezes keyboard-driven inset
      // updates while it runs, and a close event swallowed by that freeze
      // leaves the keyboard padding permanently applied — overshooting the
      // anchor and leaving a phantom bottom inset once the reply streams in.
      void KeyboardController.dismiss()
        .then(() => {
          if (
            selectedThreadKeyRef.current !== targetThreadKey ||
            lastScrolledSubmittedMessageIdRef.current !== submittedMessageId
          ) {
            return;
          }
          return scrollMessageToEnd({ animated: true, closeKeyboard: false });
        })
        .catch(() => {
          if (
            selectedThreadKeyRef.current !== targetThreadKey ||
            lastScrolledSubmittedMessageIdRef.current !== submittedMessageId
          ) {
            return;
          }
          lastScrolledSubmittedMessageIdRef.current = null;
          freeze.set(false);
        });
    });
    return () => cancelAnimationFrame(frame);
  }, [
    anchorMessageId,
    submittedMessageId,
    freeze,
    contentPresentationKind,
    props.queuedMessages,
    selectedThreadFeed,
    scrollMessageToEnd,
    selectedThreadKey,
  ]);

  const handleSendMessage = useCallback(
    async (followUp?: ActiveTurnComposerAction) => {
      if (rewinding) return null;
      const targetThreadKey = selectedThreadKey;
      const hasUserMessage = selectedThreadFeed.some(
        (entry) => entry.type === "message" && entry.message.role === "user",
      );
      const messageId = await props.onSendMessage(followUp);
      if (messageId === null || selectedThreadKeyRef.current !== targetThreadKey) {
        return messageId;
      }

      if (navigation.isFocused() && AppState.currentState === "active") {
        playThreadFeedback("sent");
      }

      // A sent message makes the snapshot stale; a refused send leaves it in place.
      clearUsageLimitsFor(targetThreadKey);

      setSubmittedMessageId(messageId);
      setAnchorMessageId(
        resolveThreadFeedSubmissionAnchor({
          currentAnchorMessageId: anchorMessageId,
          submittedMessageId: messageId,
          hasStartedTurn: props.selectedThread.latestRun !== null,
          hasUserMessage,
          queuedMessageCount: props.selectedThreadQueueCount,
        }),
      );
      composerEditorRef.current?.blur();
      return messageId;
    },
    [
      anchorMessageId,
      rewinding,
      clearUsageLimitsFor,
      navigation,
      props.onSendMessage,
      props.selectedThread.latestRun,
      props.selectedThreadQueueCount,
      selectedThreadFeed,
      selectedThreadKey,
    ],
  );

  const handleEditPendingMessage = useCallback(
    async (message: QueuedThreadMessage) => {
      if (composerSlotHidden) return;
      try {
        if (
          (await editPendingThreadMessage(message)) &&
          selectedThreadKeyRef.current === scopedThreadKey(message.environmentId, message.threadId)
        ) {
          composerEditorRef.current?.focus();
        }
      } catch (error) {
        Alert.alert(
          "Could not edit message",
          error instanceof Error ? error.message : "Please try again.",
        );
      }
    },
    [composerSlotHidden],
  );

  const collapseComposer = useCallback(() => {
    composerEditorRef.current?.blur();
  }, []);

  const handleUseArtifactTemplate = useCallback(
    (template: CodexArtifactTemplate) => {
      const currentDraft = draftMessageRef.current;
      const nextDraft = appendCodexArtifactTemplateUsePrompt(currentDraft, template);
      if (nextDraft !== currentDraft) {
        draftMessageRef.current = nextDraft;
        props.onChangeDraftMessage(nextDraft);
      }
      requestAnimationFrame(() => {
        composerEditorRef.current?.focus();
        composerEditorRef.current?.setSelection({ start: nextDraft.length, end: nextDraft.length });
      });
    },
    [props.onChangeDraftMessage],
  );

  const changeDraftMessage = props.onChangeDraftMessage;
  const handleQuoteMessage = useCallback(
    (text: string) => {
      const quote = prepareMessageQuote(draftMessageRef.current, text);
      if (quote.kind === "too-long") {
        Alert.alert(
          "Quote is too long",
          "Shorten your draft or quote a smaller part of the message.",
        );
        return;
      }
      const nextDraft = quote.text;
      draftMessageRef.current = nextDraft;
      changeDraftMessage(nextDraft);
      void Haptics.selectionAsync().catch(() => undefined);
      requestAnimationFrame(() => {
        composerEditorRef.current?.focus();
        composerEditorRef.current?.setSelection({ start: nextDraft.length, end: nextDraft.length });
      });
    },
    [changeDraftMessage],
  );

  // Gliding to the end from far up renders every row it passes at once, a 200-400 ms stall
  // right after the tap. Landing instantly instead leaves the rows above unmeasured, so the
  // next fling back up stutters. Jump to about one screen above the end, then glide the rest.
  const handleScrollToEnd = useCallback(() => {
    void Haptics.selectionAsync();
    const glide = () =>
      scrollMessageToEnd({ animated: true, closeKeyboard: false }).catch(() => {
        freeze.set(false);
      });
    const list = listRef.current;
    const state = list?.getState();
    const landing = state === undefined ? 0 : state.contentLength - 2 * state.scrollLength;
    if (list === null || state === undefined || landing <= state.scroll + state.scrollLength) {
      void glide();
      return;
    }
    void list.scrollToOffset({ offset: landing, animated: false }).then(glide);
  }, [freeze, scrollMessageToEnd]);

  const showScrollToEndButton = contentPresentationKind === "ready" && !endFollowEnabled;
  const { themeAppearance } = useAppearancePreferences();
  const isDarkMode = themeAppearance === "dark";

  const handleFeedTouchStart = useCallback((event: GestureResponderEvent) => {
    feedTouchStartRef.current = {
      pageX: event.nativeEvent.pageX,
      pageY: event.nativeEvent.pageY,
    };
  }, []);

  const handleFeedTouchMove = useCallback((event: GestureResponderEvent) => {
    const start = feedTouchStartRef.current;
    if (!start) {
      return;
    }
    const deltaX = event.nativeEvent.pageX - start.pageX;
    const deltaY = event.nativeEvent.pageY - start.pageY;
    if (Math.hypot(deltaX, deltaY) > 8) {
      feedTouchStartRef.current = null;
    }
  }, []);

  const handleFeedTouchEnd = useCallback(() => {
    if (feedTouchStartRef.current) {
      collapseComposer();
    }
    feedTouchStartRef.current = null;
  }, [collapseComposer]);

  const handleFeedTouchCancel = useCallback(() => {
    feedTouchStartRef.current = null;
  }, []);

  const content = (
    <View className="flex-1">
      {props.selectedThread.source.comparison ? (
        <ComparisonMembers
          comparison={props.selectedThread.source.comparison}
          environmentId={props.environmentId}
          threadId={props.selectedThread.id}
        />
      ) : null}
      {!usesNativeWorkspaceColumns ? <NativeLayoutObserver onChange={setScreenMetrics} /> : null}
      {showContent ? (
        <View
          style={{ flex: 1 }}
          onTouchStart={handleFeedTouchStart}
          onTouchMove={handleFeedTouchMove}
          onTouchEnd={handleFeedTouchEnd}
          onTouchCancel={handleFeedTouchCancel}
        >
          <View
            pointerEvents="none"
            className={
              Platform.OS === "android"
                ? "absolute inset-0 bg-thread-canvas"
                : "absolute inset-0 bg-screen"
            }
          />
          {chatBackdropEnabled ? (
            <NewChatBackdrop docked mood={chatBackdropMood(mascotState)} />
          ) : (
            <ThreadEmbers
              threadId={props.selectedThread.id}
              activity={
                props.activePendingApproval !== null || props.activePendingUserInput !== null
                  ? "needsYou"
                  : props.activeWorkStartedAt !== null
                    ? "working"
                    : "idle"
              }
            />
          )}
          <RenderErrorBoundary
            key={selectedThreadKey}
            resetKeys={[props.threadCwd]}
            renderFallback={(fallback) => (
              <RenderFailureView
                {...fallback}
                title="The conversation couldn't be displayed"
                bottomInset={estimatedOverlayHeight}
              />
            )}
          >
            {casualVoice ? (
              <CasualVoiceControl
                environmentId={props.environmentId}
                threadId={props.selectedThread.id}
              />
            ) : null}
            <ThreadFeed
              agentAvatars={agentAvatars}
              environmentId={props.environmentId}
              threadId={props.selectedThread.id}
              workspaceRoot={props.threadCwd}
              feed={props.selectedThreadFeed}
              mediaJump={props.mediaJump}
              findAnchorReader={props.findAnchorReader}
              onMediaJumpHandled={props.onMediaJumpHandled}
              pendingHandoff={props.pendingHandoff}
              worktreeSetup={props.worktreeSetup}
              setupWorkingStartedAt={props.setupWorkingStartedAt}
              queuedMessages={props.queuedMessages}
              dispatchingMessageId={props.dispatchingMessageId}
              editingMessageId={props.queuedRunEdit?.messageId ?? null}
              steerWait={props.steerWait ?? null}
              onSendSteerNow={props.onSendSteerNow}
              // A native subagent has no composer to edit a pending message in;
              // Cancel on the edit banner would discard it.
              onEditPendingMessage={
                isProviderSubagent || composerSlotHidden ? null : handleEditPendingMessage
              }
              onQuoteMessage={
                isProviderSubagent || composerSlotHidden || !props.canOperateThread
                  ? undefined
                  : handleQuoteMessage
              }
              contentPresentation={props.contentPresentation}
              showLoadingPlaceholder={showLoadingPlaceholder}
              agentLabel={agentLabel}
              agentDriver={agentProvider?.driver}
              visitedAtOpen={visitedAtOpen}
              threadTitle={props.selectedThread.title}
              draftKey={props.composerDraftKey}
              canOperateMessage={
                props.canOperateThread && !isProviderSubagent && !composerSlotHidden
              }
              supportsRollback={
                agentProvider !== undefined && agentProvider.supportsConversationRollback !== false
              }
              messageRunActive={
                props.activeThreadBusy ||
                props.dispatchingMessageId !== null ||
                (props.runlessWorkActive ?? false)
              }
              rewindInProgress={rewinding}
              onRewindingChange={setRewinding}
              latestRun={props.activityRun}
              activeWorkStartedAt={props.activeWorkStartedAt}
              runlessWorkActive={props.runlessWorkActive ?? false}
              listRef={listRef}
              freeze={freeze}
              anchorMessageId={anchorMessageId}
              submittedMessageId={submittedMessageId}
              contentInsetEndAdjustment={combinedContentInsetEndAdjustment}
              contentTopInset={0}
              contentBottomInset={
                estimatedOverlayHeight +
                (showFloatingStatus ? FLOATING_WORKING_CONTROL_COVERAGE : 0)
              }
              contentMaxWidth={contentMaxWidth}
              historyControls={props.historyControls}
              contentSideInsets={nativeMetrics?.safeArea}
              layoutVariant={layoutVariant}
              usesAutomaticContentInsets={props.usesAutomaticContentInsets}
              onHeaderMaterialVisibilityChange={props.onHeaderMaterialVisibilityChange}
              onEndFollowEnabledChange={setEndFollowEnabled}
              skills={selectedProviderSkills}
              onUseArtifactTemplate={handleUseArtifactTemplate}
            />
          </RenderErrorBoundary>
        </View>
      ) : (
        <View className="flex-1" />
      )}

      {showContent ? (
        <ThreadBrowserFloat
          key={selectedThreadKey}
          environmentId={props.environmentId}
          threadId={props.selectedThread.id}
          tabs={browserTabs.tabs}
          loaded={browserTabs.loaded}
          top={navigationHeaderHeight + 8}
          onOpen={openBrowserPreview}
        />
      ) : null}

      {/* Floating composer — sticks to keyboard via KeyboardStickyView */}
      {showContent ? (
        <KeyboardStickyView
          // iOS emits a native animated height target on both will-show and
          // will-hide, so stay subscribed for the full transition. Android
          // retains its background/resume stale-state quarantine.
          enabled={Platform.OS === "ios" || (isKeyboardVisible && !keyboardStateSuspect)}
          pointerEvents="box-none"
          style={{ position: "absolute", bottom: 0, left: 0, right: 0, top: 0 }}
          offset={{ closed: 0, opened: 0 }}
        >
          <ComposerPopoverHost hidden={composerSlotHidden}>
            {/* The fixed sticky host gives this bottom-anchored child a stable
              coordinate space. Its top and height can then animate together
              instead of the auto-sized host jumping to Yoga's destination. */}
            <Animated.View
              layout={COMPOSER_LAYOUT_TRANSITION}
              pointerEvents="box-none"
              style={[
                {
                  position: "absolute",
                  bottom: controlInsets.bottom,
                  left: controlInsets.left,
                  right: controlInsets.right,
                },
                composerWidthStyle,
              ]}
            >
              {/* No paddingTop here: the overlay's measured height becomes the
                list's bottom inset, so any padding above the pill/composer
                pushes the resting content floor up by the same amount. */}
              <View ref={composerOverlayRef} onLayout={onComposerLayout} className="w-full">
                {props.findBar}
                {discord && floatingStatus?.kind === "working" ? (
                  <DiscordTypingIndicator label={agentLabel} startedAt={floatingStatus.startedAt} />
                ) : null}
                <FloatingWorkingControl
                  colorScheme={isDarkMode ? "dark" : "light"}
                  status={discord && floatingStatus?.kind === "working" ? null : floatingStatus}
                  mascotState={mascotState}
                  mascotMoment={mascotMoment}
                  lift={floatingControlLift}
                  devicePreview={
                    devicePreviews.length > 0
                      ? { count: devicePreviews.length, onPress: openDevicePreview }
                      : null
                  }
                  browserPreview={
                    browserTabs.tabs.length > 0
                      ? { count: browserTabs.tabs.length, onPress: () => openBrowserPreview() }
                      : null
                  }
                  showScrollToEnd={showScrollToEndButton}
                  onScrollToEnd={handleScrollToEnd}
                  agents={discord ? null : agentsSegment}
                  onOpenAgents={openAgentsSheet}
                  queuedCount={queuedCount}
                  queueHeld={queueHeld}
                  onOpenQueue={() => {
                    Keyboard.dismiss();
                    navigation.navigate("ThreadQueue", {
                      environmentId: props.environmentId,
                      threadId: props.selectedThread.id,
                    });
                  }}
                />
                <View className="w-full self-center" style={{ maxWidth: contentMaxWidth }}>
                  {props.queuedRunEdit !== null ? (
                    <Animated.View
                      className="shrink-0"
                      entering={DETAIL_CARD_ENTER_QUICK}
                      exiting={DETAIL_CARD_EXIT_QUICK}
                    >
                      <ComposerQueuedEditBanner
                        saving={props.isSavingQueuedEdit}
                        onCancel={() => {
                          voiceInputSession.cancel(props.composerDraftKey);
                          props.onCancelQueuedRunEdit();
                        }}
                      />
                    </Animated.View>
                  ) : null}
                  {!usageLimitsReport ? (
                    <ProviderCreditNotice
                      provider={agentProvider}
                      environmentId={props.environmentId}
                    />
                  ) : null}
                  <UsageLimitRecoveryCard
                    key={props.selectedThread.latestRun?.runId}
                    thread={props.selectedThread}
                    environmentId={props.environmentId}
                  />
                  {props.feedbackSubmissions.map((submission) => (
                    <ComposerFeedback
                      key={submission.id}
                      submission={submission}
                      onDismiss={() => props.onDismissFeedback(submission.id)}
                    />
                  ))}
                  {composerError !== null ? (
                    <Animated.View
                      className="shrink-0"
                      entering={DETAIL_CARD_ENTER_QUICK}
                      exiting={DETAIL_CARD_EXIT_QUICK}
                    >
                      <ComposerErrorNotice
                        message={composerError}
                        onDismiss={() => clearThreadComposerError(selectedThreadKey)}
                      />
                    </Animated.View>
                  ) : null}
                  {usageLimitsReport && activeUserInputRequestId === null ? (
                    <Animated.View
                      className="shrink-0 px-4 pb-3"
                      entering={DETAIL_CARD_ENTER}
                      exiting={DETAIL_CARD_EXIT}
                    >
                      <ComposerUsageLimits
                        report={usageLimitsReport}
                        provider={agentProvider}
                        threadId={props.selectedThread.id}
                        context={props.usageContext}
                        environmentId={props.environmentId}
                        onClose={dismissUsageLimits}
                      />
                    </Animated.View>
                  ) : null}
                  {props.creationState?.kind === "failed" ? (
                    <Animated.View
                      className="shrink-0 px-4"
                      style={{ paddingBottom: composerBottomInset }}
                      entering={DETAIL_CARD_ENTER}
                      exiting={DETAIL_CARD_EXIT}
                    >
                      <ThreadCreationFailedCard
                        reason={props.creationState.reason}
                        onEditTask={props.creationState.onEditTask}
                      />
                    </Animated.View>
                  ) : null}
                  {props.activePendingApproval ||
                  (props.activePendingUserInput && !parentAnswersQuestion) ? (
                    <Animated.View
                      className="shrink-0 gap-3 px-4 pb-3"
                      entering={DETAIL_CARD_ENTER}
                      exiting={DETAIL_CARD_EXIT}
                    >
                      {props.activePendingApproval ? (
                        <PendingApprovalCard
                          heightConstraints={pendingUserInputHeightConstraints}
                          canOperateThread={props.canOperateThread}
                          approval={props.activePendingApproval}
                          respondingApprovalId={props.respondingApprovalId}
                          onRespond={props.onRespondToApproval}
                        />
                      ) : null}
                      {props.activePendingUserInput && !parentAnswersQuestion ? (
                        <PendingUserInputCard
                          canOperateThread={
                            props.canOperateThread || props.connectionStateLabel !== "connected"
                          }
                          pendingUserInput={props.activePendingUserInput}
                          deliveryStatus={props.userInputDeliveryStatus}
                          heightConstraints={pendingUserInputHeightConstraints}
                          collapsed={userInputCollapsed}
                          onToggleCollapsed={handleToggleUserInputCollapsed}
                          onStopThread={userInputOwnsComposerSlot ? props.onStopThread : undefined}
                          cardProgress={userInputCardProgress}
                          cardCoverage={userInputCardCoverage}
                          onInputFocusChange={handleOwnedInputFocusChange}
                          drafts={props.activePendingUserInputDrafts}
                          answers={props.activePendingUserInputAnswers}
                          respondingUserInputId={props.respondingUserInputId}
                          onSelectOption={props.onSelectUserInputOption}
                          onChangeCustomAnswer={props.onChangeUserInputCustomAnswer}
                          onSubmit={props.onSubmitUserInput}
                          onDismiss={props.onDismissUserInput}
                          composerAnswer={
                            isProviderSubagent || composerSlotHidden
                              ? undefined
                              : { hasText: props.draftMessage.trim().length > 0 }
                          }
                        />
                      ) : null}
                    </Animated.View>
                  ) : null}
                </View>

                {/* Keep the same editor visible through question transitions. */}
                <View style={composerSlotHidden ? { display: "none" } : undefined}>
                  {isProviderSubagent || parentAnswersQuestion ? (
                    <View
                      className="self-center px-3 pt-1.5"
                      style={{
                        width: "100%",
                        maxWidth: contentMaxWidth,
                        paddingBottom: composerBottomInset + 6,
                      }}
                    >
                      {parentAnswersQuestion ? (
                        <DelegatedQuestionBar
                          onOpenParent={
                            props.selectedThread.lineage.parentThreadId === null
                              ? null
                              : () =>
                                  navigation.navigate("Thread", {
                                    environmentId: String(subagentParentEnvironmentId),
                                    threadId: String(props.selectedThread.lineage.parentThreadId),
                                  })
                          }
                        />
                      ) : (
                        <ProviderSubagentBar
                          connectionState={props.connectionStateLabel}
                          provider={providerSubagentProvider ?? null}
                          modelLabel={
                            providerSubagentCatalogModel?.name ??
                            formatModelSlugName(props.selectedThread.modelSelection.model)
                          }
                          effortLabel={formatModelSelectionEffort(
                            props.selectedThread.modelSelection,
                            providerSubagentProvider?.models,
                            reportedModelSelection,
                          )}
                          speedLabel={
                            modelTraits({
                              capabilities: providerSubagentCatalogModel?.capabilities,
                              selection: props.selectedThread.modelSelection,
                            }).speed
                          }
                          status={props.providerSubagentStatus ?? null}
                          onSendThroughParent={
                            subagentParentThreadId !== null && props.canOperateThread
                              ? sendThroughParent
                              : null
                          }
                          sentThroughParent={relayedSubagentMessages}
                          onOpenParent={
                            props.selectedThread.lineage.parentThreadId === null
                              ? null
                              : () =>
                                  navigation.navigate("Thread", {
                                    environmentId: String(subagentParentEnvironmentId),
                                    threadId: String(props.selectedThread.lineage.parentThreadId),
                                  })
                          }
                        />
                      )}
                    </View>
                  ) : (
                    <>
                      <ThreadComposer
                        sharedSkills={sharedSkills}
                        hidden={composerSlotHidden}
                        planTipBlocked={
                          // A question or an approval owns this space while it is open.
                          props.activePendingApproval !== null ||
                          props.activePendingUserInput !== null
                        }
                        canOperateThread={props.canOperateThread && !rewinding}
                        reportedModelSelection={reportedModelSelection}
                        editorRef={composerEditorRef}
                        draftMessage={props.draftMessage}
                        draftAttachments={props.draftAttachments}
                        placeholder={
                          props.activePendingUserInput ? "Or type your own answer…" : "Reply…"
                        }
                        pendingAnswer={
                          props.activePendingUserInput && !parentAnswersQuestion
                            ? {
                                canSubmit:
                                  props.activePendingUserInputAnswers !== null ||
                                  props.draftMessage.trim().length > 0,
                                responding:
                                  props.respondingUserInputId ===
                                    props.activePendingUserInput.requestId ||
                                  props.activePendingUserInput.responseCapability ===
                                    "not_resumable",
                                onSubmit: props.onSubmitUserInput,
                              }
                            : null
                        }
                        contentMaxWidth={contentMaxWidth}
                        connectionState={props.connectionStateLabel}
                        environmentLabel={props.environmentLabel}
                        selectedThread={props.selectedThread}
                        hasCompactableConversation={
                          hasCompactableConversation && !props.isCompacting
                        }
                        serverConfig={props.serverConfig}
                        queueCount={props.selectedThreadQueueCount}
                        activeThreadBusy={props.activeThreadBusy}
                        canStopThread={props.canStopThread}
                        environmentId={props.environmentId}
                        projectCwd={props.threadCwd ?? props.projectWorkspaceRoot}
                        // Follow-ups typed before the server creates the thread wait in
                        // the draft: queueing them against a thread id the server may
                        // still reject would strand them in the outbox.
                        sendBlockedReason={
                          props.creationState?.kind === "preparing" &&
                          !props.creationState.serverOwned
                            ? "Starting the task…"
                            : null
                        }
                        draftKey={props.composerDraftKey ?? undefined}
                        followUpBehavior={props.followUpBehavior}
                        canSteerActiveTurn={props.canSteerActiveTurn}
                        queuedEdit={
                          props.queuedRunEdit === null
                            ? null
                            : {
                                existingAttachments: props.queuedRunEdit.existingAttachments,
                                saving: props.isSavingQueuedEdit,
                                onRemoveExistingAttachment: props.onRemoveQueuedEditAttachment,
                              }
                        }
                        bottomInset={composerBottomInset}
                        onChangeDraftMessage={(value) => {
                          const request = props.activePendingUserInput;
                          const question =
                            request?.questions.find(
                              (entry) => entry.id === props.activePendingUserInputQuestionId,
                            ) ?? request?.questions[0];
                          if (request && question && question.allowCustomAnswer !== false)
                            props.onChangeUserInputCustomAnswer(
                              request.requestId,
                              question.id,
                              value,
                            );
                          else props.onChangeDraftMessage(value);
                        }}
                        onPickDraftMedia={props.onPickDraftMedia}
                        onPickDraftFiles={props.onPickDraftFiles}
                        onNativePasteImages={props.onNativePasteImages}
                        onNativePasteText={props.onNativePasteText}
                        onRemoveDraftImage={props.onRemoveDraftImage}
                        onStopThread={props.onStopThread}
                        onSendMessage={handleSendMessage}
                        onShowUsageLimits={showUsageLimits}
                        canSwitchProvider={props.canSwitchThreadProvider}
                        onUpdateModelSelection={props.onUpdateThreadModelSelection}
                        onUpdateRuntimeMode={props.onUpdateThreadRuntimeMode}
                        onUpdateInteractionMode={props.onUpdateThreadInteractionMode}
                        onExpandedChange={setComposerExpanded}
                        onEditorFocusChange={handleComposerFocusChange}
                      />
                    </>
                  )}
                </View>
              </View>
            </Animated.View>
          </ComposerPopoverHost>
        </KeyboardStickyView>
      ) : null}
    </View>
  );
  return (
    <HarnessMascotDriver value={threadMascot.driver}>
      <HarnessMascotAgentId value={threadMascot.agentId}>
        <HarnessMascotTurnDuration value={harnessMascotCompletedTurnDuration(props.activityRun)}>
          <ImageMarkupDraftKey value={props.composerDraftKey ?? selectedThreadKey}>
            {content}
          </ImageMarkupDraftKey>
        </HarnessMascotTurnDuration>
      </HarnessMascotAgentId>
    </HarnessMascotDriver>
  );
});
