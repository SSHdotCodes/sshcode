import { useModelMentionCatalog } from "./use-model-mention-catalog";
import { useChatBackdropEnabled } from "./useNewChatDashboard";
import { isWorkflowThread } from "../workflows/workflowVisibility";
import { useWorkflowComposer } from "../workflows/useWorkflowComposer";
import {
  flushComposerEditorInput,
  persistScheduledComposerMessage,
  scheduledComposerMessageReason,
} from "./scheduledComposerMessage";
import { clearDraftIfSubmittedTextMatches } from "./sideChatPresentation";
import { scheduledMessageUnavailableReason } from "@t3tools/client-runtime/scheduled-message";
import { ScheduleMessageSheet } from "./ScheduleMessageSheet";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, type CommandId } from "@t3tools/contracts";
import { useEnvironmentScopeDenied } from "../../state/session";
import { usePrivacyLabel } from "../../state/use-privacy-mode";
import { useTerminalHandoff } from "../../state/terminal-handoff";
import { useUiMode } from "../discord/useUiMode";
import { ComposerModelControl } from "../../components/ComposerModelControl";
import { composerAcpInstanceName } from "../../lib/providerInstanceName";
import { ImageMarkupDraftKey } from "../../components/ImageMarkupContext";
import { pendingSends, pendingSendMetadata } from "../../state/pending-sends";
import type { ComposerTextPaste } from "../../native/T3ComposerEditor.types";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useAtomValue } from "@effect/atom-react";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import { pastedTextDisposition, replaceTextSelection } from "@t3tools/client-runtime/text-paste";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  parseSideChatCommand,
  sideChatKindForDriver,
  type ChatAttachment,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerConfig as T3ServerConfig,
  type SharedSkillsList,
  type UsageLimitsReport,
} from "@t3tools/contracts";
import {
  collectProviderUsageLimits,
  hasProviderUsageLimits,
  isUsageLimitsCommand,
} from "@t3tools/shared/usageLimits";
import { StackActions, useFocusEffect, useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import {
  memo,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Alert, Keyboard, Platform, Pressable, View, type ViewStyle } from "react-native";
import { composerImageGallery } from "../../lib/composerImageGallery";
import { filePreviewGallery } from "../../lib/filePreviewGallery";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import {
  composerAttachmentUploadBlockReason,
  composerAttachmentsStillUploading,
  composerAttachmentUploadsAtom,
} from "../../state/composer-attachment-uploads";
import Animated, {
  FadeIn,
  FadeOut,
  type LayoutAnimationFunction,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { armAgentAwarenessLiveActivityForLocalWork } from "../agent-awareness/remoteRegistration";
import { scopedThreadKey } from "../../lib/scopedEntities";
import {
  getComposerDraftSnapshot,
  composerDraftsAtom,
  setComposerDraftText,
  composerContextImportsAtom,
  countComposerDraftAttachmentsAfterSelection,
} from "../../state/use-composer-drafts";
import { appAtomRegistry } from "../../state/atom-registry";
import type { ComposerDocumentAttachment } from "../../lib/composerContext";
import { useProject, useThreadShells } from "../../state/entities";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";

import { AppText as Text } from "../../components/AppText";
import { ComposerAttachmentButton } from "../../components/ComposerAttachmentButton";
import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import { VideoPreviewModal, type VideoPreviewSource } from "../../components/VideoPreviewModal";
import { GlassSurface } from "../../components/GlassSurface";
import { ComposerEditor, type ComposerEditorHandle } from "../../components/ComposerEditor";
import { fileRoutePathSegments } from "../files/filePath";
import { ComposerActionButton, ComposerToolbarRow } from "../../components/ComposerToolbar";
import { ProviderIcon } from "../../components/ProviderIcon";
import {
  composerStripAttachments,
  type DraftComposerAttachment,
  type DraftComposerFileAttachment,
} from "../../lib/composerImages";
import {
  buildModelOptions,
  groupByProvider,
  isModelSelectionUnavailable,
  resolveProvidersEnabledForProject,
  useModelListSelection,
} from "../../lib/modelOptions";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import type { RemoteClientConnectionState } from "../../lib/connection";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { ControlPillMenu } from "../../components/ControlPill";
import type { ActiveTurnComposerAction } from "@t3tools/client-runtime/state/composer-dispatch";
import type { FollowUpBehavior } from "../../lib/followUpBehavior";
import {
  resolveComposerSendPresentation,
  type ComposerSendPresentation,
} from "./composerSendPresentation";
import { ComposerCommandPopover } from "./ComposerCommandPopover";
import { ComposerPopoverAnchor } from "./ComposerPopoverAnchor";
import { PlanTip } from "./PlanTip";
import { accountAcceptsModel } from "@t3tools/shared/accountBalance";
import { ComposerQueuedEditAttachments } from "./ComposerQueuedEdit";
import { useComposerCommandMenu } from "./use-composer-command-menu";
import {
  ComposerDictationCancelAction,
  ComposerDictationDraftContent,
  ComposerDictationPrimaryAction,
  ComposerDictationStartAction,
  ComposerDictationStatus,
  ComposerDictationToolbar,
} from "../voice-input/ComposerDictationControl";
import { useVoiceInputController } from "../voice-input/useVoiceInputController";
import { resolveVoiceComposerPresentation } from "../voice-input/voiceInputPresentation";
import {
  rememberModelOptions,
  withRememberedModelOptions,
} from "../../state/use-model-option-memory";
import {
  type ExistingThreadSettingsRouteSession,
  useExistingThreadSettingsRoutePresentation,
} from "./ThreadSettingsSheet";
import {
  useThreadSettingsSheetPresentation,
  type NavigationWithFinishTransitioning,
} from "./use-thread-settings-sheet-presentation";

/**
 * Height of the collapsed composer (pill + vertical padding, excluding safe-area inset).
 * Exported so the parent can compute feed overlap / content insets.
 */
export const COMPOSER_COLLAPSED_CHROME = 60;

/**
 * Height of the expanded composer (card + toolbar + vertical padding, excluding safe-area inset).
 * Used by the parent to compute the larger feed bottom inset when the composer is focused.
 */
export const COMPOSER_EXPANDED_CHROME = 156;

const WorkflowPicker = lazy(() =>
  import("../workflows/WorkflowPicker").then((module) => ({ default: module.WorkflowPicker })),
);

export interface ThreadComposerProps {
  readonly canOperateThread: boolean;
  readonly draftMessage: string;
  readonly draftAttachments: ReadonlyArray<DraftComposerAttachment>;
  readonly placeholder: string;
  readonly contentMaxWidth?: number;
  readonly bottomInset?: number;
  readonly connectionState: RemoteClientConnectionState;
  readonly environmentLabel: string | null;
  /**
   * Message sync phase for the selected thread (drives the status pill):
   * "loading" = first fetch, nothing to show yet; "syncing" = cached messages
   * are on screen while they reconcile with the server.
   */
  readonly threadSyncPhase?: "loading" | "syncing" | null;
  readonly selectedThread: EnvironmentThreadShell;
  readonly reportedModelSelection?: ModelSelection | null;
  readonly hasCompactableConversation: boolean;
  readonly serverConfig: T3ServerConfig | null;
  readonly queueCount: number;
  readonly activeThreadBusy: boolean;
  readonly canStopThread: boolean;
  readonly environmentId: EnvironmentId;
  readonly sharedSkills: SharedSkillsList | null;
  readonly projectCwd: string | null;
  /** Why sending is blocked right now (shown as the send button's label), or null. */
  readonly sendBlockedReason?: string | null;
  /** Where the composer's content lives. Defaults to this thread's own draft. */
  readonly draftKey?: string;
  readonly hidden?: boolean;
  readonly planTipBlocked?: boolean;
  /**
   * Set while a queued message is open for editing: the send button saves the
   * edit instead of sending, and the message's server attachments stay visible
   * above the composer so they can be removed.
   */
  readonly queuedEdit?: {
    readonly existingAttachments: ReadonlyArray<ChatAttachment>;
    readonly saving: boolean;
    readonly onRemoveExistingAttachment: (attachmentId: string) => void;
  } | null;
  /** The user's configured behavior for a message sent during a running turn. */
  readonly followUpBehavior: FollowUpBehavior;
  /** Whether the live turn can actually be steered by this provider. */
  readonly canSteerActiveTurn: boolean;
  readonly editorRef?: RefObject<ComposerEditorHandle | null>;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onPickDraftMedia: (source?: "library" | "camera") => Promise<void>;
  readonly onPickDraftFiles: () => Promise<void>;
  readonly onNativePasteImages: (uris: ReadonlyArray<string>) => Promise<void>;
  readonly onNativePasteText: (paste: ComposerTextPaste) => Promise<void>;
  readonly onRemoveDraftImage: (imageId: string) => void;
  readonly onStopThread: () => void;
  readonly onSendMessage: (followUp?: ActiveTurnComposerAction) => Promise<MessageId | null>;
  readonly pendingAnswer?: {
    readonly canSubmit: boolean;
    readonly responding: boolean;
    readonly onSubmit: () => Promise<unknown>;
  } | null;
  /** `/usage-limits` resolves locally; the host decides where the report shows. Null clears it. */
  readonly onShowUsageLimits: (report: UsageLimitsReport | null) => void;
  /**
   * Whether the model picker may offer providers other than this thread's.
   * False keeps the catalog on the instance the thread's session runs on.
   */
  readonly canSwitchProvider: boolean;
  readonly onUpdateModelSelection: (
    modelSelection: ModelSelection,
    options?: { remember?: boolean },
  ) => void;
  readonly onUpdateRuntimeMode: (runtimeMode: RuntimeMode) => void;
  readonly onUpdateInteractionMode: (interactionMode: ProviderInteractionMode) => void;
  readonly onExpandedChange?: (expanded: boolean) => void;
  /** Fires on editor focus/blur; hosts use it to vet stale keyboard state. */
  readonly onEditorFocusChange?: (focused: boolean) => void;
}

/**
 * The pill / card container — renders with Expo's native GlassView on supported
 * iOS 26+ devices, with a frosted blur fallback where supported.
 * Exported so NewTaskDraftScreen can render the same composer chrome.
 */
// The bottom-anchored dock position and clipped surface height use the same
// transition so the card grows upward without exposing its final-size content.
// Android gets NO layout transition: the composer rides the keyboard via
// KeyboardStickyView (frame-synced to the IME), and a time-based morph
// running alongside that translate reads as jitter. Snapping the layout and
// letting the keyboard-synced slide be the only motion looks native there.
export const COMPOSER_TRANSITION_DURATION_MS = 220;
// Side panes already animate the dock's width. Nested horizontal layout
// transitions would leave the surface trailing its toolbar's new position.
// Keep the vertical pill/card morph while horizontal layout follows the dock.
const composerHeightTransition: LayoutAnimationFunction = (values) => {
  "worklet";
  const timing = {
    duration: COMPOSER_TRANSITION_DURATION_MS,
    reduceMotion: ReduceMotion.System,
  };
  return {
    initialValues: {
      originX: values.targetOriginX,
      originY: values.currentOriginY,
      width: values.targetWidth,
      height: values.currentHeight,
    },
    animations: {
      originX: values.targetOriginX,
      originY: withTiming(values.targetOriginY, timing),
      width: values.targetWidth,
      height: withTiming(values.targetHeight, timing),
    },
  };
};
export const COMPOSER_LAYOUT_TRANSITION =
  Platform.OS === "android" ? undefined : composerHeightTransition;

const COMPOSER_ATTACHMENT_ENTERING =
  Platform.OS === "android"
    ? FadeIn.duration(160)
    : FadeIn.delay(COMPOSER_TRANSITION_DURATION_MS).duration(160).reduceMotion(ReduceMotion.System);

const AnimatedGlassSurface = Animated.createAnimatedComponent(GlassSurface);

const FOLLOW_UP_ACTION_LABEL = {
  queue: "Queue",
  steer: "Steer now",
  restart: "Restart turn",
} as const;

const FOLLOW_UP_ACTION_SUBTITLE = {
  queue: "Run after the current turn",
  steer: "Joins the running turn, or waits for the next",
  restart: "Start the turn over with this message",
} as const;

/**
 * The composer's primary button. While a turn is running it also long-presses
 * into the two follow-up behaviors, which is mobile's stand-in for the Command
 * modifier a hardware keyboard has.
 */
function SendActionButton(props: {
  readonly accessibilityLabel: string;
  readonly presentation: ComposerSendPresentation;
  readonly disabled: boolean;
  readonly onSend: (followUp?: ActiveTurnComposerAction) => void;
}) {
  const { presentation } = props;
  const button = (
    <ComposerActionButton
      accessibilityLabel={props.accessibilityLabel}
      icon={presentation.icon}
      variant="primary"
      disabled={props.disabled}
      onPress={() => props.onSend()}
    />
  );
  if (!presentation.offersFollowUpChoice || presentation.action === null || props.disabled) {
    return button;
  }
  const actions = [presentation.action, presentation.alternate].filter(
    (action): action is ActiveTurnComposerAction => action !== null,
  );
  return (
    <ControlPillMenu
      accessibilityLabel="Choose how to send this message"
      shouldOpenOnLongPress
      actions={actions.map((action) => ({
        id: action,
        title: FOLLOW_UP_ACTION_LABEL[action],
        subtitle: FOLLOW_UP_ACTION_SUBTITLE[action],
        state: action === presentation.action ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) =>
        props.onSend(nativeEvent.event as ActiveTurnComposerAction)
      }
    >
      {button}
    </ControlPillMenu>
  );
}

export function ComposerSurface(props: {
  readonly children: ReactNode;
  readonly style: ViewStyle;
  /** Morphs between the compact and expanded composer layouts. */
  readonly animateLayout?: boolean;
  readonly opaque?: boolean;
}) {
  const colors = useUniwindTheme();
  const [chatBackdropEnabled] = useChatBackdropEnabled();
  const [uiMode] = useUiMode();
  const discord = uiMode === "discord";
  const targetBorderRadius =
    typeof props.style.borderRadius === "number" ? props.style.borderRadius : 0;
  const animatedBorderRadius = useSharedValue(targetBorderRadius);
  const shouldAnimate = props.animateLayout !== false && Platform.OS !== "android";
  useLayoutEffect(() => {
    animatedBorderRadius.value = shouldAnimate
      ? withTiming(targetBorderRadius, {
          duration: COMPOSER_TRANSITION_DURATION_MS,
          reduceMotion: ReduceMotion.System,
        })
      : targetBorderRadius;
  }, [animatedBorderRadius, shouldAnimate, targetBorderRadius]);
  const animatedShapeStyle = useAnimatedStyle(() => ({
    borderRadius: animatedBorderRadius.value,
  }));
  const layoutTransition = shouldAnimate ? COMPOSER_LAYOUT_TRANSITION : undefined;

  // Each native frame follows the same transition. Animating only the outer
  // clip leaves the glass and content at their final height on the first frame.
  return (
    <Animated.View
      className={
        Platform.OS === "android" ? undefined : "shadow-[0_6px_28px] shadow-adaptive-black-a15-a35"
      }
      layout={layoutTransition}
      style={[
        animatedShapeStyle,
        {
          overflow: "hidden",
        },
      ]}
    >
      {discord || props.opaque || chatBackdropEnabled ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            inset: 0,
            backgroundColor: colors["--color-card"],
          }}
        />
      ) : (
        <AnimatedGlassSurface
          chrome="none"
          fallbackColor={colors["--color-composer-surface"]}
          fallbackClassName="border border-composer-border"
          glassEffectStyle="regular"
          // The composer is a passive material containing interactive controls.
          // Keep native glass out of the interactive content's layout path.
          pointerEvents="none"
          tintColor="transparent"
          layout={layoutTransition}
          style={[{ position: "absolute", inset: 0 }, animatedShapeStyle]}
        >
          {null}
        </AnimatedGlassSurface>
      )}
      <Animated.View
        collapsable={false}
        layout={layoutTransition}
        style={[props.style, animatedShapeStyle]}
      >
        {props.children}
      </Animated.View>
    </Animated.View>
  );
}

export const ThreadComposer = memo(function ThreadComposer(props: ThreadComposerProps) {
  const privateLabel = usePrivacyLabel();
  const terminalHandoff = useTerminalHandoff(
    props.environmentId,
    props.selectedThread.id,
    props.serverConfig?.environment.capabilities.terminalHandoff === true,
  );
  const [uiMode] = useUiMode();
  const discord = uiMode === "discord";
  const project = useProject(scopeProjectRef(props.environmentId, props.selectedThread.projectId));
  const { themeVariables: materialTheme } = useAppearancePreferences();
  const composerPanel = materialTheme["--color-composer-panel"];
  const navigation = useNavigation();
  const foregroundColor = useUniwindTheme()["--color-foreground"];
  const bodyText = useScaledTextRole("body");
  const fallbackInputRef = useRef<ComposerEditorHandle>(null);
  const inputRef = props.editorRef ?? fallbackInputRef;
  const [isFocused, setIsFocused] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const upsertScheduledMessage = useAtomCommand(serverEnvironment.upsertScheduledTask, {
    reportFailure: false,
  });
  const canScheduleMessage = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(props.environmentId),
  );
  const operateDenied = useEnvironmentScopeDenied(
    props.environmentId,
    AuthOrchestrationOperateScope,
  );
  const pendingPastedTextAttachmentCountRef = useRef(0);
  const [pendingPastedTextAttachmentCount, setPendingPastedTextAttachmentCount] = useState(0);
  const settingsSheetPresentation = useThreadSettingsSheetPresentation({
    editorRef: inputRef,
    isEditorFocused: isFocused,
  });
  const settingsRoutePresentation = useExistingThreadSettingsRoutePresentation();
  const settingsRoutePresentedRef = useRef(false);
  const wasExpandedBeforePreviewRef = useRef(false);
  const inFlightThreadIdsRef = useRef(new Set<string>());
  const { onExpandedChange } = props;

  const [previewFile, setPreviewFile] = useState<FilePreviewSource | null>(null);
  const [previewVideo, setPreviewVideo] = useState<VideoPreviewSource | null>(null);
  const queuedEdit = props.queuedEdit ?? null;
  const hasContent =
    props.draftMessage.trim().length > 0 ||
    props.draftAttachments.length > 0 ||
    (queuedEdit?.existingAttachments.length ?? 0) > 0;
  // Only media belongs above the composer; every other file reads as its inline chip.
  const stripAttachments = useMemo(
    () => composerStripAttachments(props.draftAttachments),
    [props.draftAttachments],
  );
  // Stopping the agent is not what the send button means in edit mode.
  const showStopAction =
    !props.pendingAnswer && !hasContent && props.canStopThread && queuedEdit === null;

  const uploadStates = useAtomValue(composerAttachmentUploadsAtom);
  const attachmentsUploading =
    props.connectionState === "connected" &&
    composerAttachmentsStillUploading({
      environmentId: props.environmentId,
      attachments: props.draftAttachments,
      serverConfig: props.serverConfig,
      states: uploadStates,
    });
  // Every send goes through the outbox; the label says whether it leaves now
  // or waits (for the connection, an earlier queued message, or an upload).
  const normalSendPresentation = resolveComposerSendPresentation({
    editingQueuedMessage: queuedEdit !== null,
    running: props.activeThreadBusy,
    canSteer: props.canSteerActiveTurn,
    followUpBehavior: props.followUpBehavior,
    deliveryDeferred:
      props.connectionState !== "connected" || props.queueCount > 0 || attachmentsUploading,
  });
  const sendPresentation = props.pendingAnswer
    ? {
        ...normalSendPresentation,
        label: "Submit",
        action: null,
        alternate: null,
        offersFollowUpChoice: false,
      }
    : normalSendPresentation;
  const sendLabel = sendPresentation.label;
  const currentModelSelection = props.selectedThread.modelSelection;
  const planTipProviders = useMemo(
    () => resolveProvidersEnabledForProject(props.serverConfig, props.selectedThread.projectId),
    [props.serverConfig, props.selectedThread.projectId],
  );
  // A chat that already ran is only offered its other account when this one is nearly out:
  // moving it costs a full re-read. Closed once, the tip stays closed on every device.
  const updateServerSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "account tip dismissal",
    reportFailure: false,
  });
  const serverSettings = props.serverConfig?.settings;
  const chatHasRun = props.selectedThread.latestRun !== null;
  const accountTip = useMemo(() => {
    if (!chatHasRun || !serverSettings) return undefined;
    const dismissed = serverSettings.accountTipDismissedThreads;
    const { environmentId, id, projectId } = props.selectedThread;
    return {
      dismissed: dismissed.includes(id),
      onDismiss: () => {
        void updateServerSettings({
          environmentId,
          input: {
            patch: { dismissAccountTipForThread: id },
          },
        });
      },
      accepts: accountAcceptsModel(serverSettings, projectId),
    };
  }, [chatHasRun, props.selectedThread, serverSettings, updateServerSettings]);
  const currentRuntimeMode = props.selectedThread.runtimeMode;
  const modelUnavailable =
    props.connectionState === "connected" &&
    isModelSelectionUnavailable(
      props.serverConfig,
      currentModelSelection,
      props.selectedThread.projectId,
    );
  const selectedProviderStatus = useMemo(() => {
    if (!props.serverConfig) return null;
    return (
      props.serverConfig.providers.find(
        (p) => p.instanceId === props.selectedThread.modelSelection.instanceId,
      ) ?? null
    );
  }, [props.serverConfig, props.selectedThread.modelSelection.instanceId]);
  const composerOwnerKey = scopedThreadKey(props.environmentId, props.selectedThread.id);
  // Content lives under the edit's own draft while a queued message is open;
  // the owner key still identifies this composer for settings and dictation.
  const composerDraftKey = props.draftKey ?? composerOwnerKey;
  const workflowComposer = useWorkflowComposer({
    environmentId: props.environmentId,
    threadId: props.selectedThread.id,
    draftKey: composerDraftKey,
    connected: props.connectionState === "connected",
    available:
      !props.draftKey &&
      !isWorkflowThread(props.selectedThread) &&
      props.selectedThread.lineage.relationshipToParent !== "subagent",
  });
  const { interceptSend: interceptWorkflowSend } = workflowComposer;
  const openDraftDocument = (attachment: ComposerDocumentAttachment) => {
    Keyboard.dismiss();
    navigation.navigate("ThreadAttachment", {
      environmentId: String(props.environmentId),
      threadId: String(props.selectedThread.id),
      attachmentId: attachment.attachmentId,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: String(attachment.sizeBytes),
      draftKey: composerDraftKey,
    });
  };
  const { onSendMessage, onChangeDraftMessage, onShowUsageLimits } = props;
  // T3 owns /usage-limits only where Limits has data for the selected provider;
  // elsewhere the name stays the provider's own and is sent through untouched.
  const usageLimitsOffered =
    selectedProviderStatus !== null &&
    hasProviderUsageLimits(
      selectedProviderStatus.driver,
      props.serverConfig?.providers ?? [],
      props.serverConfig?.usageLimitSources ?? [],
    );
  // `/btw` on Claude and `/side` on Codex open the harness's side chat in a
  // sheet instead of reaching the thread, even while the agent works.
  const sideChatKind = sideChatKindForDriver(selectedProviderStatus?.driver);
  // Answered locally from the last Limits snapshot; the agent never sees it.
  const openUsageLimits = useCallback(() => {
    const report = collectProviderUsageLimits(
      currentModelSelection.instanceId,
      props.serverConfig?.providers ?? [],
      props.serverConfig?.usageLimitSources ?? [],
      Date.now(),
    );
    onShowUsageLimits(report);
    if (!report) {
      Alert.alert("Usage limits unavailable", "This provider does not currently report limits.");
    }
    return report !== null;
  }, [currentModelSelection.instanceId, onShowUsageLimits, props.serverConfig]);

  const modelCatalogInput = useModelMentionCatalog(props.serverConfig?.settings);
  const mentionModelOptions = useMemo(
    () => buildModelOptions(props.serverConfig, null, undefined, props.selectedThread.projectId),
    [props.serverConfig, props.selectedThread.projectId],
  );
  const composerMenu = useComposerCommandMenu({
    sharedSkills: props.sharedSkills,
    modelOptions: mentionModelOptions,
    modelCatalogInput,
    modelProviders: props.serverConfig?.providers,
    draftMessage: props.draftMessage,
    ownerKey: composerDraftKey,
    environmentId: props.environmentId,
    threadShells: useThreadShells(),
    currentThreadId: props.selectedThread.id,
    projectCwd: props.projectCwd,
    pullRequestProjectId: props.serverConfig?.environment.capabilities.pullRequests
      ? (project?.id ?? null)
      : null,
    pullRequestRepository: project?.repositoryIdentity?.displayName ?? null,
    threadPullRequests: props.selectedThread.pullRequests,
    selectedProviderStatus,
    hasThread: true,
    hasCompactableConversation: props.hasCompactableConversation,
    onChangeDraftMessage: props.onChangeDraftMessage,
    onUpdateInteractionMode:
      selectedProviderStatus?.showInteractionModeToggle === false
        ? undefined
        : props.onUpdateInteractionMode,
    offersUsageLimits: usageLimitsOffered,
    onWorkflow: workflowComposer.enabled ? workflowComposer.openPicker : undefined,
    onPickWorkflow: workflowComposer.enabled ? workflowComposer.pick : undefined,
    // With attachments aboard the pick just inserts the text, so it sends as a prompt.
    onUsageLimits:
      usageLimitsOffered && props.draftAttachments.length === 0 ? openUsageLimits : undefined,
  });
  const voiceInput = useVoiceInputController({
    ownerKey: composerDraftKey,
    label: props.selectedThread.title || "Untitled chat",
    readDraftMessage: () => getComposerDraftSnapshot(composerDraftKey).text,
    subscribeToDraftChanges: (onChange) => appAtomRegistry.subscribe(composerDraftsAtom, onChange),
    selection: composerMenu.selection,
    onChangeDraftMessage: (text) => setComposerDraftText(composerDraftKey, text),
    onChangeSelection: composerMenu.onSelectionChange,
  });
  const isSubmissionLocked = queuedEdit?.saving === true || voiceInput.blocksSubmission;
  const voicePresentation = resolveVoiceComposerPresentation(
    voiceInput.state,
    voiceInput.elapsedSeconds,
  );
  const isVoiceInputPresented = voicePresentation.statusLabel !== null;
  // An open draft stays visible; only a collapsed composer becomes a voice strip.
  const isExpanded =
    isFocused ||
    settingsSheetPresentation.keepsComposerExpanded ||
    stripAttachments.length > 0 ||
    (queuedEdit?.existingAttachments.length ?? 0) > 0;
  const showsCompactDictation = isVoiceInputPresented && !isExpanded;
  const isToolbarVisible = isExpanded || isVoiceInputPresented;
  const attachmentBlockReason = composerAttachmentUploadBlockReason({
    environmentId: props.environmentId,
    attachments: props.draftAttachments,
    connected: props.connectionState === "connected",
    serverConfig: props.serverConfig,
    states: uploadStates,
  });
  const contextImports = useAtomValue(composerContextImportsAtom);
  const sendBlockedReason =
    (queuedEdit?.saving === true ? "Saving…" : null) ??
    terminalHandoff.blockReason ??
    props.sendBlockedReason ??
    (pendingPastedTextAttachmentCount > 0 ? "Attaching pasted text" : null) ??
    (props.pendingAnswer ? null : attachmentBlockReason);
  const canSend =
    (props.canOperateThread || props.connectionState !== "connected") &&
    (props.pendingAnswer
      ? props.pendingAnswer.canSubmit && !props.pendingAnswer.responding
      : hasContent) &&
    !contextImports[composerDraftKey] &&
    !isSubmissionLocked &&
    sendBlockedReason === null &&
    (Boolean(props.pendingAnswer) || !modelUnavailable);

  // Keep the feed inset aligned with the card or compact dictation strip.
  useEffect(() => {
    onExpandedChange?.(isExpanded);
  }, [isExpanded, onExpandedChange]);

  const onPressPreview = useCallback(
    (source: FilePreviewSource) => {
      wasExpandedBeforePreviewRef.current = isFocused;
      setPreviewVideo(null);
      setPreviewFile(
        (current) =>
          current ?? {
            ...source,
            gallery: filePreviewGallery(source, composerImageGallery(props.draftAttachments)),
          },
      );
    },
    [isFocused, props.draftAttachments],
  );

  const closePreview = useCallback(() => {
    setPreviewFile(null);
    setPreviewVideo(null);
    if (wasExpandedBeforePreviewRef.current) {
      setTimeout(() => {
        if (navigation.isFocused()) inputRef.current?.focus();
      }, 100);
    }
  }, [inputRef, navigation]);

  const onPressVideo = useCallback(
    (attachment: DraftComposerFileAttachment, sourceIdentifier: string) => {
      wasExpandedBeforePreviewRef.current = isFocused;
      setPreviewFile(null);
      setPreviewVideo((current) => current ?? { type: "local", attachment, sourceIdentifier });
    },
    [isFocused],
  );

  const scheduleMessage = async (runAt: string, commandId: CommandId) => {
    const unavailable = scheduledMessageUnavailableReason(props.serverConfig);
    if (unavailable) throw new Error(unavailable);
    await inputRef.current?.flushPendingInput();
    const readPendingWork = () => ({
      pastedTextAttachments: pendingPastedTextAttachmentCountRef.current,
      importingContext: appAtomRegistry.get(composerContextImportsAtom)[composerDraftKey] === true,
    });
    const draft = getComposerDraftSnapshot(composerDraftKey);
    const contentReason = scheduledComposerMessageReason(draft, readPendingWork());
    if (contentReason) throw new Error(contentReason);
    if (!canScheduleMessage || props.connectionState !== "connected")
      throw new Error("Connect to the environment before scheduling.");
    if (queuedEdit) throw new Error("Finish editing the queued message before scheduling.");
    const result = await persistScheduledComposerMessage({
      draft,
      readDraft: () => getComposerDraftSnapshot(composerDraftKey),
      readPendingWork,
      persist: () =>
        upsertScheduledMessage({
          environmentId: props.environmentId,
          input: {
            commandId,
            title: draft.text.trim().slice(0, 80),
            prompt: draft.text.trim(),
            enabled: true,
            schedule: { type: "once", runAt },
            projectId: props.selectedThread.projectId,
            threadId: props.selectedThread.id,
            modelSelection: currentModelSelection ?? props.selectedThread.modelSelection,
            workspaceStrategy: { type: "root" },
            runtimeMode: currentRuntimeMode,
            interactionMode: props.selectedThread.interactionMode,
            creationSource: "mobile",
          },
        }),
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    const current = getComposerDraftSnapshot(composerDraftKey);
    if (
      current.text === draft.text &&
      scheduledComposerMessageReason(current, readPendingWork()) === null
    )
      setComposerDraftText(composerDraftKey, "");
    Alert.alert(
      "Message scheduled",
      `${new Date(runAt).toLocaleString()}. Edit or cancel it in Settings → Scheduled tasks.`,
    );
  };

  const onEditorFocusChange = props.onEditorFocusChange;
  const handleFocus = useCallback(() => {
    setIsFocused(true);
    onExpandedChange?.(true);
    onEditorFocusChange?.(true);
  }, [onEditorFocusChange, onExpandedChange]);

  const handleBlur = useCallback(() => {
    setIsFocused(false);
    if (!settingsSheetPresentation.keepsComposerExpanded) {
      onExpandedChange?.(false);
    }
    onEditorFocusChange?.(false);
  }, [onEditorFocusChange, onExpandedChange, settingsSheetPresentation.keepsComposerExpanded]);
  const pendingAnswerRef = useRef(props.pendingAnswer);
  useLayoutEffect(() => {
    pendingAnswerRef.current = props.pendingAnswer;
  }, [props.pendingAnswer]);
  const flushingInputRef = useRef(false);
  const handleSend = useCallback(
    async (followUp?: ActiveTurnComposerAction) => {
      if (
        terminalHandoff.blockReason ||
        isSubmissionLocked ||
        pendingPastedTextAttachmentCountRef.current > 0
      )
        return;
      if (!(await flushComposerEditorInput(inputRef.current, flushingInputRef))) return;
      if (pendingPastedTextAttachmentCountRef.current > 0) return;
      const answer = pendingAnswerRef.current;
      if (answer) {
        if (!answer.responding) await answer.onSubmit();
        return;
      }
      if (await interceptWorkflowSend()) return;
      const outgoingDraft = getComposerDraftSnapshot(composerDraftKey);
      // Typed out in full rather than picked from the menu. Attachments mean the
      // user is sending a prompt, so those go through as usual.
      if (
        usageLimitsOffered &&
        isUsageLimitsCommand(outgoingDraft.text) &&
        outgoingDraft.attachments.length === 0
      ) {
        if (openUsageLimits()) onChangeDraftMessage("");
        return;
      }
      const sideChat =
        queuedEdit === null ? parseSideChatCommand(outgoingDraft.text, sideChatKind) : null;
      if (sideChat) {
        const threadKey = scopedThreadKey(props.environmentId, props.selectedThread.id);
        if (inFlightThreadIdsRef.current.has(threadKey)) return;
        inFlightThreadIdsRef.current.add(threadKey);
        try {
          if (sideChat.prompt.length > 0) {
            await pendingSends.enqueue({
              ...pendingSendMetadata(),
              kind: "side-question",
              environmentId: props.environmentId,
              threadId: props.selectedThread.id,
              prompt: sideChat.prompt,
            });
          }
          Keyboard.dismiss();
          navigation.navigate("ThreadSideChat", {
            environmentId: String(props.environmentId),
            threadId: String(props.selectedThread.id),
            kind: sideChat.kind,
          });
          clearDraftIfSubmittedTextMatches({
            currentText: getComposerDraftSnapshot(threadKey).text,
            submittedText: outgoingDraft.text,
            clear: () => onChangeDraftMessage(""),
          });
        } catch (error) {
          Alert.alert(
            "Could not save the side question",
            error instanceof Error
              ? error.message
              : "Your message is still in the composer. Try sending again.",
          );
        } finally {
          inFlightThreadIdsRef.current.delete(threadKey);
        }
        return;
      }
      const threadKey = scopedThreadKey(props.environmentId, props.selectedThread.id);
      if (inFlightThreadIdsRef.current.has(threadKey)) return;
      inFlightThreadIdsRef.current.add(threadKey);
      try {
        const messageId = await onSendMessage(followUp);
        if (messageId === null) {
          return;
        }
        // Sending a prompt starts agent work: arm the lock-screen card while the
        // app is foregrounded and the activity token can be registered. Armed
        // after the send so its preference read and native Activity start don't
        // contend with the queued-message feedback on the tap frame.
        armAgentAwarenessLiveActivityForLocalWork({
          environmentId: props.environmentId,
          threadTitle: props.selectedThread.title,
          projectTitle: props.environmentLabel ?? "SSHCode",
        });
      } finally {
        inFlightThreadIdsRef.current.delete(threadKey);
      }
    },
    [
      interceptWorkflowSend,
      composerDraftKey,
      terminalHandoff.blockReason,
      props.draftMessage,
      props.draftAttachments.length,
      navigation,
      onChangeDraftMessage,
      openUsageLimits,
      queuedEdit,
      sideChatKind,
      usageLimitsOffered,
      onSendMessage,
      props.environmentId,
      props.environmentLabel,
      props.selectedThread.id,
      props.selectedThread.title,
      isSubmissionLocked,
    ],
  );

  // ── Model menu ───────────────────────────────────────────
  // A session that hands the conversation to another provider lets the picker
  // offer the whole catalog; one that can't stays on its own instance.
  const lockedProviderInstanceId = props.canSwitchProvider
    ? undefined
    : currentModelSelection.instanceId;
  const modelListSelection = useModelListSelection(currentModelSelection);
  const modelOptions = useMemo(
    () =>
      buildModelOptions(
        props.serverConfig,
        modelListSelection,
        lockedProviderInstanceId,
        props.selectedThread.projectId,
      ),
    [
      props.serverConfig,
      modelListSelection,
      lockedProviderInstanceId,
      props.selectedThread.projectId,
    ],
  );
  const threadProviderGroups = useMemo(() => groupByProvider(modelOptions), [modelOptions]);
  const currentModelOption =
    modelOptions.find(
      (option) =>
        option.selection.instanceId === currentModelSelection.instanceId &&
        option.selection.model === currentModelSelection.model,
    ) ?? null;
  const modelLabel = currentModelOption?.label ?? currentModelSelection.model;
  const acpInstanceName = composerAcpInstanceName({
    providerDriver: currentModelOption?.providerDriver,
    providerIconUrl: currentModelOption?.providerIconUrl,
    providerLabel: currentModelOption?.providerLabel ?? "",
    instanceId: currentModelOption?.providerKey,
    providers: props.serverConfig?.providers,
  });
  const providerOptionDescriptors = useMemo(
    () =>
      resolveProviderOptionDescriptors({
        capabilities: currentModelOption?.capabilities,
        selections: currentModelSelection.options,
      }),
    [currentModelOption?.capabilities, currentModelSelection.options],
  );
  const settingsOwnerId = composerOwnerKey;
  const settingsRouteSession = useMemo<ExistingThreadSettingsRouteSession>(
    () => ({
      ownerId: settingsOwnerId,
      environmentId: props.environmentId,
      projectId: props.selectedThread.projectId,
      providerInstanceId: currentModelSelection.instanceId,
      ...(lockedProviderInstanceId ? { lockedProviderInstanceId } : {}),
      providerGroups: threadProviderGroups,
      selectedModel: currentModelSelection,
      reportedModelSelection: props.reportedModelSelection,
      onSelectModel: (option) => props.onUpdateModelSelection(option.selection),
      optionDescriptors: providerOptionDescriptors,
      onUpdateOptionSelections: (options) => {
        rememberModelOptions(
          currentModelSelection.instanceId,
          currentModelSelection.model,
          options ?? [],
        );
        props.onUpdateModelSelection({ ...currentModelSelection, options });
      },
      runtimeMode: currentRuntimeMode,
      onUpdateRuntimeMode: props.onUpdateRuntimeMode,
    }),
    [
      currentModelSelection,
      props.reportedModelSelection,
      currentRuntimeMode,
      props.onUpdateModelSelection,
      props.onUpdateRuntimeMode,
      providerOptionDescriptors,
      settingsOwnerId,
      lockedProviderInstanceId,
      threadProviderGroups,
      props.selectedThread.projectId,
    ],
  );
  const openSettings = useCallback(() => {
    settingsRoutePresentation.present(settingsRouteSession);
    settingsSheetPresentation.open();
  }, [settingsRoutePresentation.present, settingsRouteSession, settingsSheetPresentation.open]);

  useEffect(() => {
    if (settingsSheetPresentation.isActive) {
      settingsRoutePresentation.present(settingsRouteSession);
    }
  }, [settingsRoutePresentation.present, settingsRouteSession, settingsSheetPresentation.isActive]);

  useEffect(() => {
    if (!settingsSheetPresentation.isVisible || settingsRoutePresentedRef.current) {
      return;
    }

    settingsRoutePresentedRef.current = true;
    navigation.dispatch(StackActions.push("ThreadSettingsSheet"));
  }, [navigation, settingsSheetPresentation.isVisible]);

  useFocusEffect(
    useCallback(() => {
      if (!settingsRoutePresentedRef.current) {
        return;
      }

      settingsRoutePresentedRef.current = false;
      settingsSheetPresentation.onDismissed();
      settingsRoutePresentation.clear(settingsOwnerId);
    }, [settingsOwnerId, settingsRoutePresentation.clear, settingsSheetPresentation.onDismissed]),
  );

  useEffect(
    () =>
      // UIKit's completion callback for the sheet dismissal, surfaced by the
      // native-stack patch. This is when the queued keyboard restore runs.
      (navigation as unknown as NavigationWithFinishTransitioning).addListener(
        "finishTransitioning",
        settingsSheetPresentation.onStackTransitionsFinished,
      ),
    [navigation, settingsSheetPresentation.onStackTransitionsFinished],
  );

  // The door to the Agents view, which also holds New subagent and the Subagents switch.
  const onOpenAgents = () => {
    Keyboard.dismiss();
    navigation.navigate("ThreadAgents", {
      environmentId: props.environmentId,
      threadId: props.selectedThread.id,
    });
  };
  return (
    <Animated.View
      className="px-[12px]"
      style={{
        paddingTop: isExpanded ? 8 : 6,
        paddingBottom: (props.bottomInset ?? 0) + (isExpanded ? 8 : 6),
        backgroundColor:
          Platform.OS === "android" ? themeColorWithAlpha(composerPanel, 1) : undefined,
      }}
    >
      {terminalHandoff.blockReason && (
        <View className="flex-row items-center justify-between gap-2 px-2 py-2">
          <Text className="flex-1 text-xs">
            {terminalHandoff.status?.phase === "handing-off"
              ? "Handing this chat to Terminal…"
              : "This chat is open in Terminal."}
          </Text>
          {terminalHandoff.status?.phase === "in-terminal" && (
            <Pressable
              accessibilityRole="button"
              disabled={!terminalHandoff.allowed}
              onPress={terminalHandoff.bringBack}
            >
              <Text className="text-xs">Bring back</Text>
            </Pressable>
          )}
        </View>
      )}
      {/* The backdrop gradient lives on a plain View: Reanimated's Animated.View
          silently drops experimental_backgroundImage on Android, which left this
          strip fully transparent and the feed text legible through the composer. */}
      <View
        className={
          Platform.OS === "android"
            ? "hidden"
            : "absolute inset-0 bg-linear-to-b from-screen/0 via-screen/60 to-screen/90"
        }
        pointerEvents="none"
      />
      <Animated.View
        className="relative w-full self-center"
        style={{ maxWidth: props.contentMaxWidth }}
      >
        {!isSubmissionLocked && composerMenu.trigger ? (
          <ComposerPopoverAnchor>
            <ComposerCommandPopover
              items={composerMenu.items}
              triggerKind={composerMenu.trigger.kind}
              isLoading={composerMenu.isLoading}
              error={composerMenu.error}
              onSelect={composerMenu.onSelect}
            />
          </ComposerPopoverAnchor>
        ) : null}

        {selectedProviderStatus?.compatibilityAdvisory?.message &&
        (selectedProviderStatus.compatibilityAdvisory.status === "unsupported" ||
          selectedProviderStatus.compatibilityAdvisory.status === "broken") ? (
          <Text
            accessibilityRole={
              selectedProviderStatus.compatibilityAdvisory.status === "broken" ? "alert" : undefined
            }
            accessibilityLiveRegion={
              selectedProviderStatus.compatibilityAdvisory.status === "broken"
                ? "assertive"
                : "polite"
            }
            className={
              selectedProviderStatus.compatibilityAdvisory.status === "broken"
                ? "bg-danger px-3 py-2 text-xs text-danger-foreground"
                : "px-3 py-2 text-xs text-foreground"
            }
          >
            {selectedProviderStatus.compatibilityAdvisory.message}
          </Text>
        ) : null}
        {modelUnavailable ? (
          <Pressable accessibilityRole="button" className="px-3 py-2" onPress={openSettings}>
            <Text className="text-xs text-foreground">Model unavailable. Open model settings.</Text>
          </Pressable>
        ) : null}

        {serverSettings?.balanceAccounts ? (
          <PlanTip
            chatKey={composerOwnerKey}
            providers={planTipProviders}
            selection={currentModelSelection}
            running={accountTip}
            blocked={
              props.hidden === true ||
              props.planTipBlocked === true ||
              settingsSheetPresentation.isActive ||
              !props.canOperateThread ||
              props.connectionState !== "connected"
            }
            onSelect={(instanceId, model) => {
              const option = buildModelOptions(
                props.serverConfig,
                null,
                instanceId,
                props.selectedThread.projectId,
              ).find((candidate) => candidate.selection.model === model);
              // Only the account changes: the chat keeps its effort and speed.
              if (option) {
                props.onUpdateModelSelection(
                  withRememberedModelOptions(
                    option.selection,
                    model === currentModelSelection?.model
                      ? (currentModelSelection.options ?? [])
                      : undefined,
                  ),
                );
              }
            }}
          />
        ) : null}
        <ComposerSurface
          style={
            isExpanded
              ? {
                  borderRadius: 26,
                  minHeight: discord ? 92 : 140,
                  overflow: "hidden" as const,
                  paddingBottom: 6,
                  paddingTop: 14,
                }
              : {
                  // Keep the numeric radius close to the expanded card so the
                  // shape morph stays bounded while rendering as a capsule.
                  borderRadius: 27,
                  overflow: "hidden" as const,
                  paddingVertical: 2,
                }
          }
        >
          <ComposerDictationDraftContent
            className={isExpanded ? undefined : "flex-row items-center"}
            compact={!isExpanded}
            hidden={showsCompactDictation}
          >
            {!isExpanded ? (
              <ComposerAttachmentButton
                disabled={isSubmissionLocked}
                onScheduleMessage={() => {
                  void Promise.resolve(inputRef.current?.flushPendingInput()).finally(() =>
                    setScheduleOpen(true),
                  );
                }}
                scheduleUnavailableReason={scheduledMessageUnavailableReason(props.serverConfig)}
                supportsFiles={Boolean(
                  props.serverConfig?.environment.capabilities.fileAttachments,
                )}
                onPickMedia={props.onPickDraftMedia}
                onPickCamera={() => props.onPickDraftMedia("camera")}
                onPickFiles={props.onPickDraftFiles}
                onOpenAgents={onOpenAgents}
              />
            ) : null}
            {isExpanded && queuedEdit !== null && queuedEdit.existingAttachments.length > 0 ? (
              <Animated.View
                className="px-[14px] pb-2.5"
                entering={COMPOSER_ATTACHMENT_ENTERING}
                exiting={FadeOut.duration(120)}
              >
                <ComposerQueuedEditAttachments
                  environmentId={props.environmentId}
                  attachments={queuedEdit.existingAttachments}
                  disabled={isSubmissionLocked}
                  onRemove={queuedEdit.onRemoveExistingAttachment}
                />
              </Animated.View>
            ) : null}
            {isExpanded && stripAttachments.length > 0 ? (
              <Animated.View
                className="px-[14px] pb-2.5"
                entering={COMPOSER_ATTACHMENT_ENTERING}
                exiting={FadeOut.duration(120)}
              >
                <ComposerAttachmentStrip
                  environmentId={props.environmentId}
                  attachments={stripAttachments}
                  imageSize={56}
                  imageBorderRadius={12}
                  onRemove={isSubmissionLocked ? () => undefined : props.onRemoveDraftImage}
                  onPressPreview={isSubmissionLocked ? undefined : onPressPreview}
                  onPressVideo={isSubmissionLocked ? undefined : onPressVideo}
                  onPressDocument={
                    isSubmissionLocked
                      ? undefined
                      : (attachment) =>
                          openDraftDocument({
                            attachmentId: attachment.id,
                            name: attachment.name,
                            mimeType: attachment.mimeType,
                            sizeBytes: attachment.sizeBytes,
                          })
                  }
                />
              </Animated.View>
            ) : null}
            <Animated.View
              className={isExpanded ? "px-[14px]" : "min-w-0 flex-1 px-[4px]"}
              layout={COMPOSER_LAYOUT_TRANSITION}
            >
              <ComposerEditor
                draftKey={composerDraftKey}
                hidden={props.hidden}
                environmentId={props.environmentId}
                onOpenMention={(path) => {
                  Keyboard.dismiss();
                  navigation.navigate("ThreadFile", {
                    environmentId: String(props.environmentId),
                    threadId: String(props.selectedThread.id),
                    path: fileRoutePathSegments(path),
                  });
                }}
                onOpenAttachment={openDraftDocument}
                // A rested composer full of chips left almost nowhere to tap to start typing:
                // every chip opened its file instead. Collapsed, they focus the editor.
                chipsInert={!isExpanded}
                onInertChipPress={() => inputRef.current?.focus()}
                ref={inputRef}
                multiline
                value={props.draftMessage}
                readOnly={isSubmissionLocked || voiceInput.freezesEditor}
                skills={composerMenu.skills}
                selection={composerMenu.selection}
                onChangeText={(text) => {
                  if (!isSubmissionLocked) props.onChangeDraftMessage(text);
                }}
                onSelectionChange={composerMenu.onSelectionChange}
                onPasteImages={(uris) => {
                  if (!isSubmissionLocked) void props.onNativePasteImages(uris);
                }}
                onPasteText={(paste) => {
                  if (isSubmissionLocked) return;
                  const insertPaste = () => {
                    const insertion = replaceTextSelection({
                      value: paste.value,
                      selection: paste.selection,
                      text: paste.text,
                    });
                    const selection = { start: insertion.cursor, end: insertion.cursor };
                    props.onChangeDraftMessage(insertion.value);
                    composerMenu.onSelectionChange(selection);
                  };
                  const capabilities = props.serverConfig?.environment.capabilities;
                  const advertisedMax =
                    capabilities?.attachmentUploads === true
                      ? capabilities.fileAttachments?.maxUploadBytes
                      : undefined;
                  const maxBytes =
                    advertisedMax === undefined
                      ? null
                      : clampFileAttachmentUploadBytes(advertisedMax);
                  const wouldExceedInputLimit =
                    paste.value.length -
                      Math.max(0, paste.selection.end - paste.selection.start) +
                      paste.text.length >
                    PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
                  const canAttach =
                    maxBytes !== null &&
                    countComposerDraftAttachmentsAfterSelection(composerDraftKey, {
                      text: paste.value,
                      ...paste.selection,
                    }) < PROVIDER_SEND_TURN_MAX_ATTACHMENTS &&
                    new TextEncoder().encode(paste.text).byteLength <= maxBytes;
                  if (
                    pastedTextDisposition({
                      text: paste.text,
                      wouldExceedInputLimit,
                      canAttach: true,
                    }) === "attachment"
                  ) {
                    if (canAttach) {
                      pendingPastedTextAttachmentCountRef.current += 1;
                      setPendingPastedTextAttachmentCount(
                        pendingPastedTextAttachmentCountRef.current,
                      );
                      const finishAttachment = () => {
                        pendingPastedTextAttachmentCountRef.current = Math.max(
                          0,
                          pendingPastedTextAttachmentCountRef.current - 1,
                        );
                        setPendingPastedTextAttachmentCount(
                          pendingPastedTextAttachmentCountRef.current,
                        );
                      };
                      void props.onNativePasteText(paste).then(finishAttachment, finishAttachment);
                    } else if (!wouldExceedInputLimit) {
                      insertPaste();
                    } else {
                      Alert.alert(
                        wouldExceedInputLimit
                          ? "Pasted text is too large for this message"
                          : "Could not attach pasted text",
                        wouldExceedInputLimit
                          ? "Remove some text or an attachment, then paste again."
                          : "Remove an attachment or use a smaller paste, then try again.",
                      );
                    }
                    return;
                  }
                  insertPaste();
                }}
                placeholder={
                  discord
                    ? `Message #${privateLabel("Chat", props.selectedThread.id, props.selectedThread.title)}`
                    : props.placeholder
                }
                onFocus={handleFocus}
                onBlur={handleBlur}
                // Command-Return sends the other way, matching web's Mod+Enter.
                onSubmit={(alternate) =>
                  void handleSend(
                    alternate && sendPresentation.alternate !== null
                      ? sendPresentation.alternate
                      : undefined,
                  )
                }
                submitTitle={sendPresentation.label}
                alternateSubmitTitle={
                  sendPresentation.alternate === null
                    ? sendPresentation.label
                    : FOLLOW_UP_ACTION_LABEL[sendPresentation.alternate]
                }
                scrollEnabled={isExpanded}
                // Android: collapsed single line centers natively (gravity) in
                // a pill-height box matching the send button; iOS keeps insets.
                singleLineCentered={!isExpanded}
                contentInsetVertical={isExpanded || Platform.OS === "android" ? 0 : 6}
                style={
                  isExpanded
                    ? {
                        minHeight: discord ? 36 : 72,
                        maxHeight: 160,
                        paddingVertical: 4,
                      }
                    : {
                        height: 36,
                      }
                }
                textStyle={{
                  ...bodyText,
                  color: foregroundColor,
                }}
              />
            </Animated.View>
            {!isExpanded ? (
              <View className="flex-row items-center">
                <ComposerDictationStartAction
                  disabled={isSubmissionLocked}
                  state={voiceInput.state}
                  isAvailable={voiceInput.isAvailable}
                  onStart={voiceInput.start}
                  onCancel={voiceInput.cancel}
                />
                {showStopAction ? (
                  <ComposerActionButton
                    accessibilityLabel="Stop agent"
                    icon="stop.fill"
                    variant="danger"
                    disabled={!props.canOperateThread}
                    onPress={props.onStopThread}
                  />
                ) : (
                  <SendActionButton
                    accessibilityLabel={sendBlockedReason ?? sendLabel}
                    presentation={sendPresentation}
                    disabled={!canSend}
                    onSend={handleSend}
                  />
                )}
              </View>
            ) : null}
            {isExpanded ? <View className="h-1" /> : null}
          </ComposerDictationDraftContent>
          <Animated.View
            accessibilityElementsHidden={!isToolbarVisible}
            collapsable={false}
            importantForAccessibility={isToolbarVisible ? "auto" : "no-hide-descendants"}
            layout={COMPOSER_LAYOUT_TRANSITION}
            pointerEvents={isToolbarVisible ? "auto" : "none"}
            style={
              isExpanded
                ? undefined
                : {
                    position: "absolute",
                    bottom: 2,
                    left: 0,
                    right: 0,
                  }
            }
          >
            <ComposerDictationToolbar
              showsDictation={isVoiceInputPresented}
              visible={isToolbarVisible}
            >
              <ComposerToolbarRow
                paddingBottom={0}
                paddingHorizontal={0}
                paddingTop={0}
                style={{ gap: 0 }}
              >
                <ComposerDictationCancelAction
                  presentation={voicePresentation}
                  onCancel={voiceInput.cancel}
                />
                {isVoiceInputPresented ? (
                  <ComposerDictationStatus
                    audioLevels={voiceInput.audioLevels}
                    elapsedSeconds={voiceInput.elapsedSeconds}
                    phase={voiceInput.state.phase}
                    presentation={voicePresentation}
                    onDismissError={voiceInput.cancel}
                  />
                ) : (
                  <View className="min-w-0 flex-1 flex-row items-center justify-between">
                    <ComposerAttachmentButton
                      disabled={isSubmissionLocked}
                      onScheduleMessage={() => {
                        void Promise.resolve(inputRef.current?.flushPendingInput()).finally(() =>
                          setScheduleOpen(true),
                        );
                      }}
                      scheduleUnavailableReason={scheduledMessageUnavailableReason(
                        props.serverConfig,
                      )}
                      supportsFiles={Boolean(
                        props.serverConfig?.environment.capabilities.fileAttachments,
                      )}
                      onPickMedia={props.onPickDraftMedia}
                      onPickCamera={() => props.onPickDraftMedia("camera")}
                      onPickFiles={props.onPickDraftFiles}
                      onOpenAgents={onOpenAgents}
                    />
                    <View className="min-w-0 shrink">
                      <ComposerModelControl
                        capabilities={currentModelOption?.capabilities}
                        selection={currentModelSelection}
                        reportedSelection={props.reportedModelSelection}
                        emphasized
                        renderIcon={(size) => (
                          <ProviderIcon
                            iconUrl={currentModelOption?.providerIconUrl}
                            provider={currentModelOption?.providerDriver}
                            size={size}
                          />
                        )}
                        label={acpInstanceName ? `${acpInstanceName} · ${modelLabel}` : modelLabel}
                        maxWidth="100%"
                        onPress={openSettings}
                      />
                    </View>
                  </View>
                )}
                <View className="shrink-0 flex-row items-center">
                  <ComposerDictationPrimaryAction
                    disabled={isSubmissionLocked}
                    state={voiceInput.state}
                    presentation={voicePresentation}
                    isAvailable={voiceInput.isAvailable}
                    onStart={voiceInput.start}
                    onConfirm={voiceInput.stop}
                    onCancel={voiceInput.cancel}
                  />
                  {showStopAction ? (
                    <ComposerActionButton
                      accessibilityLabel="Stop agent"
                      icon="stop.fill"
                      variant="danger"
                      disabled={!props.canOperateThread}
                      onPress={props.onStopThread}
                    />
                  ) : voicePresentation.showsSend ? (
                    <SendActionButton
                      accessibilityLabel={sendBlockedReason ?? sendLabel}
                      presentation={sendPresentation}
                      disabled={!canSend}
                      onSend={handleSend}
                    />
                  ) : null}
                </View>
              </ComposerToolbarRow>
            </ComposerDictationToolbar>
          </Animated.View>
        </ComposerSurface>

        {props.connectionState === "connected" && operateDenied ? (
          <Text className="pt-2 text-xs text-foreground-muted">
            This connection cannot control this task. You can still edit your draft.
          </Text>
        ) : null}
      </Animated.View>

      {workflowComposer.pickerOpen ? (
        <Suspense fallback={null}>
          <WorkflowPicker
            environmentId={props.environmentId}
            onPick={workflowComposer.pick}
            onClose={workflowComposer.closePicker}
          />
        </Suspense>
      ) : null}
      {scheduleOpen ? (
        <ScheduleMessageSheet
          prompt={props.draftMessage}
          disabledReason={
            scheduledMessageUnavailableReason(props.serverConfig) ??
            (!canScheduleMessage
              ? "This connection cannot schedule messages."
              : props.connectionState !== "connected"
                ? "Connect to the environment first."
                : queuedEdit !== null
                  ? "Finish editing the queued message first."
                  : scheduledComposerMessageReason(getComposerDraftSnapshot(composerDraftKey), {
                      pastedTextAttachments: pendingPastedTextAttachmentCount,
                      importingContext: contextImports[composerDraftKey] === true,
                    }))
          }
          onClose={() => setScheduleOpen(false)}
          onSchedule={scheduleMessage}
        />
      ) : null}
      <VideoPreviewModal source={previewVideo} onRequestClose={closePreview} />
      <ImageMarkupDraftKey value={composerDraftKey}>
        <FilePreviewModal source={previewFile} onRequestClose={closePreview} />
      </ImageMarkupDraftKey>
    </Animated.View>
  );
});
