import { notificationChildThreadId } from "@t3tools/client-runtime/state/thread-execution";
import { formatTranscriptTimestamp } from "../../lib/time";
import { createDiscordThreadFeedProjector } from "../../lib/threadFeedProjection";
import { useModelMentions } from "../../state/model-mentions";
import { UserMessageBubble } from "./UserMessageBubble";
import {
  matchesTimelineJump,
  type TimelineJumpTarget,
} from "@t3tools/client-runtime/state/thread-search";
import type { discordAvatarIdentity } from "@t3tools/shared/discordProfile";
import { CasualAssistantMessage, CasualWorkStatus } from "../discord/CasualAssistantMessage";
import { MessageWorkflowProvider } from "./MessageWorkflowProvider";
import { useCasualVoiceActive, useUiMode } from "../discord/useUiMode";
import { DiscordMessage, TimelineDividers } from "../discord/DiscordMessage";
import { createTimelineDecorationsProjector } from "../discord/timelinePresentation";
import type { HarnessThemeView } from "@t3tools/shared/harnessThemes";
import { useHarnessProseStyle } from "../settings/appearance/useHarnessProseStyle";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { ThreadMarkdownVideo, ThreadMediaVisibleContext } from "./ThreadMarkdownVideo";
import { useMarkdownImageSource } from "../../native/useMarkdownImageSource";
import { enrichedContextLinkPresentation } from "../../lib/enrichedLinkPresentation";
import { ThreadContextDivider } from "./thread-context-divider";
import {
  ThreadHandoffDivider,
  ThreadHandoffRow,
  ThreadModelSwitchDivider,
} from "./thread-handoff-row";
import { SecretRequestCard } from "./SecretRequestCard";
import { AppActivityIndicator } from "../../components/AppActivityIndicator";
import {
  WorktreeWorkingHeader,
  WorktreeSetupCard,
  type WorktreeSetupCardProps,
} from "./worktree-setup-card";
import * as Haptics from "expo-haptics";
import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import { markLoad } from "@t3tools/client-runtime/load-marks";
import { useViewabilityAmount, type LegendListRef } from "@legendapp/list/react-native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { HandoffEndpoints } from "@t3tools/client-runtime/handoff";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import {
  resolveAgentMessagePresentation,
  resolveAnsweredQuestionPresentation,
} from "./agentMessagePresentation";
import { QuestionAnswerHistory } from "./QuestionAnswerHistory";
import { canForkProjectedAssistantItem } from "@t3tools/client-runtime/state/thread-workflows";
import {
  type OrchestrationMessageContext,
  ThreadId,
  type ChatAttachment,
  type ChatFileAttachment,
  type ChatImageAttachment,
  type ChatImageOriginal,
  type ImageAttachmentDimensions,
  type EnvironmentId,
  type MessageId,
  type OrchestrationV2TurnItemStatus,
  type OrchestrationV2UserMessageInputIntent,
  type OrchestrationV2ProjectedTurnItem,
  type RunId,
  type TurnItemId,
  type UserInputAttachmentAnswerPayload,
} from "@t3tools/contracts";
import { formatSteerWaitElapsed, type SteerWait } from "@t3tools/client-runtime/state/steer-wait";
import { renderAssistantCitationsAsText } from "@t3tools/shared/assistantCitations";
import { encodeComposerContextFragment } from "@t3tools/shared/composerContextClipboard";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import {
  parseComposerContextHref,
  collectComposerContextReferences,
  replaceComposerContextReferences,
  formatComposerContextReference,
} from "@t3tools/shared/composerContextReferences";
import { ComposerContextSheet } from "../../components/ComposerContextSheet";
import { writeComposerContextClipboard } from "../../lib/composerContextClipboard";
import {
  codexArtifactTemplatePresentationLabel,
  type CodexArtifactTemplate,
} from "@t3tools/shared/codexArtifactTemplates";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { isMarkdownFileLinkLabel } from "@t3tools/shared/markdownLinks";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  classifyMarkdownImageSource,
  markdownImageSourceFragment,
} from "@t3tools/client-runtime/markdown-images";
import { resolveViewedImageAsset } from "@t3tools/client-runtime/work-log/presentation";
import {
  renderCodexInlineDirectivesAsMarkdown,
  splitCodexArtifactTemplateMarkdown,
} from "@t3tools/shared/codexMarkdownDirectives";
import { CHAT_LIST_ANCHOR_OFFSET, resolveChatListAnchoredEndSpace } from "@t3tools/shared/chatList";
import { imageMimeType } from "@t3tools/shared/image";
import { videoMimeType } from "@t3tools/shared/video";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { HeaderHeightContext } from "@react-navigation/elements";
import { useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import { useNativeWorkspaceColumnsSupported } from "../../native/NativeWorkspaceColumns";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useId,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Platform,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text as NativeText,
  type ColorValue,
  useWindowDimensions,
  View,
} from "react-native";
import { Image as ExpoImage } from "expo-image";
import { useResolveClassNames } from "uniwind";
import { useFilePreviewGallery, FilePreviewGallery } from "../../components/FilePreviewGallery";
import { assetImageSource } from "../../lib/assetImageSource";
import { composerImageGallery } from "../../lib/composerImageGallery";
import { sameFilePreviewItems, threadImageGallery } from "./messageImageGallery";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import { MediaActionFeedbackBadge, MediaActionsMenu } from "../../components/MediaActionsMenu";
import { useMediaActions } from "../../state/mediaActions";
import {
  splitMarkdownImageGroups,
  type MarkdownImageGroupSegment,
  type MarkdownImageReference,
} from "../../lib/markdownImageGroups";
import {
  MESSAGE_IMAGE_STRIP_HEIGHT,
  ThreadImageStrip,
  type ThreadImageStripItem,
} from "./ThreadImageStrip";
import { ThreadWorkImageStrip } from "./ThreadWorkImages";
import { workGroupImageNotices, workGroupImageSources } from "./workLogImages";
import { isPdfFile } from "../../lib/filePreview";
import { flattenThemeColor } from "../../lib/mobileTheme";
import { PresentationSource } from "../../components/NativePresentation";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeIn, FadeInUp, type SharedValue } from "react-native-reanimated";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { IOS_NAV_BAR_HEIGHT } from "../../lib/layoutMetrics";
import { useFontFamily } from "../../lib/useFontFamily";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { downloadAndShareAttachment } from "../../lib/attachmentDownload";
import { hasWideMarkdownBlock } from "../../lib/wideMarkdownBlocks";
import { faviconUrlForOrigin } from "@t3tools/shared/favicon";
import {
  SelectableMarkdownText,
  type MarkdownFileContextMenu,
  type MarkdownImageRenderer,
  type MarkdownImageSourceResolver,
  type MarkdownLinkCustomization,
  type NativeMarkdownTextStyle,
  type SelectableMarkdownSkill,
} from "../../native/SelectableMarkdownText";

import { AppText as Text } from "../../components/AppText";
import { VideoPreviewModal, type VideoPreviewSource } from "../../components/VideoPreviewModal";
import { VideoAttachmentTile } from "../../components/VideoAttachmentTile";
import { MediaVideoPlayer } from "../../components/MediaVideoPlayer";
import { resolveMarkdownMediaPreview } from "../../lib/markdownMedia";
import {
  attachmentVideoPreviewSource,
  mediaVideoPreviewUri,
  mediaVideoThumbnailKey,
  type MediaVideoPreviewSource,
} from "../../lib/videoPreviewSource";
import { MessageCopyButton } from "./MessageCopyButton";
import { MessageInlineActionButton } from "./MessageInlineActionButton";
import { parseReviewCommentMessageSegments } from "../review/reviewCommentSelection";
import type { ReviewDiffTheme } from "../review/shikiReviewHighlighter";
import {
  ReviewCommentCard,
  useReviewCommentColors,
  type ReviewCommentColors,
} from "../review/ReviewCommentCard";
import { cn } from "../../lib/cn";
import {
  deriveCenteredContentHorizontalPadding,
  deriveThreadFeedInitialContentInset,
  deriveThreadWorkLogSizing,
  type LayoutVariant,
} from "../../lib/layout";
import { uuidv4 } from "../../lib/uuid";
import {
  resolveMarkdownFontSizes,
  resolveNativeMarkdownTypography,
} from "../../lib/appearancePreferences";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { markdownFileIconSource } from "../../lib/markdownFileIcons";
import { PierreEntryIcon } from "../../components/PierreEntryIcon";
import { markdownLinkIconSource } from "../../lib/markdownLinkIcons";
import {
  normalizeNativeMarkdownUrl,
  resolveHomeRelativeHref,
  resolveMarkdownInlineCodePresentation,
  resolveMarkdownLinkIcon,
  resolveMarkdownLinkPresentation,
} from "../../lib/markdownLinks";
import {
  threadFeedRunIsUnsettled,
  isContextCompactionActivityGroup,
  isContextHandoffActivityGroup,
  isSecretRequestActivityGroup,
  type ThreadFeedEntry,
  type ThreadFeedLatestRun,
} from "../../lib/threadActivity";
import type { ThreadContentPresentation } from "./threadContentPresentation";
import {
  resolveThreadFeedLiveFollow,
  shouldPinThreadFeedOpeningToEnd,
  type ThreadFeedLiveFollowEvent,
  type ThreadWorkGroupScrollPosition,
} from "./thread-feed-live-follow";
import {
  collapsedWorkLogHeight,
  ThreadDisclosureChevron,
  THREAD_DISCLOSURE_TRANSITION_MS,
  ThreadWorkGroupToggle,
  ThreadWorkingRow,
  ThreadWorkLog,
} from "./thread-work-log";
import { WorkLogBlock, WorkLogIconSlot, WorkLogLabel, WorkLogPressable } from "./work-log-layout";
import {
  createPendingThreadMessagesProjector,
  type PendingThreadFeedEntry,
} from "../../state/pending-thread-feed";
import { useAtomValue } from "@effect/atom-react";
import type { QueuedThreadMessage } from "../../state/thread-outbox-model";
import { resolveThreadFeedFixedItemSize } from "./thread-feed-item-size";
import {
  createThreadFeedRowStore,
  useThreadFeedRowVolatileSlice,
  type ThreadFeedRowStore,
  type ThreadFeedRowStoreState,
} from "./thread-feed-row-store";
import {
  createStableThreadFeedProjector,
  createThreadFeedPresentationProjector,
  threadFeedSummary,
  threadFeedFailedRunIds,
} from "../../lib/threadFeedProjection";
import { htmlRenderFrameHeight } from "@t3tools/shared/htmlRender";
import { htmlRenderRowHeight, ThreadHtmlRender } from "./HtmlRenderWebView";
import { ThreadMcpApp } from "./McpAppWebView";
import { useMarkdownCodeHighlight } from "./markdownCodeHighlightState";
import {
  assetEnvironment,
  useAssetUrl,
  useAssetUrlState,
  useRefreshAssetUrl,
} from "../../state/assets";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { usePreparedConnection } from "../../state/session";
import { useLiveThreadLinkLabels, useThreadShell } from "../../state/entities";
import { useThreadSelection } from "../../state/use-thread-selection";
import { composerDocumentAttachmentRecord } from "../../lib/composerContext";
import * as Option from "effect/Option";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  environmentThreadDetails,
  environmentThreadShells,
  threadEnvironment,
} from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useV2ItemSupport } from "../../state/v2-item-support";
import {
  fileRoutePathSegments,
  isAbsolutePath,
  resolveWorkspaceRelativeFilePath,
} from "../files/filePath";
import { waitForThreadShellReady } from "./threadForkNavigation";
import { resolveUserMessageIntentBadge } from "./userMessageIntentBadge";
import { fileChipMenu, resolveFileChipTarget, type FileChipAction } from "./fileChipMenu";
import { useFileChipShare } from "./useFileChipShare";
import {
  MarkdownImageAvailableWidthContext,
  ThreadMarkdownImage,
  ThreadMarkdownImageUnavailable,
  ThreadMarkdownImageView,
} from "./ThreadMarkdownImage";
import { XPostCards } from "./XPostCards";

const WIDE_MARKDOWN_BLOCK_OPTIONS = {
  // Native iOS blockquotes and adjacent selectable text are separate layout
  // chunks. Giving their shrink-to-fit bubble a definite width keeps both
  // chunks measured against the width at which UIKit draws them.
  includeBlockquotes: Platform.OS === "ios",
  includeOrderedLists: Platform.OS === "android",
} as const;

// Fixed heights mirror renderFeedEntry's classNames and are only used while
// text fits at the current font settings. Larger accessibility text is measured.
const TURN_FOLD_HEIGHT = 42; // min-h-11 (38.5) + mb-1 (3.5), with the mobile 14px rem
// Tailwind spacing on the mobile 14px rem: px-3.5 on the user bubble, px-1 on
// assistant rows. Images size their frame from these before their own layout.
const USER_BUBBLE_HORIZONTAL_PADDING = 3.5 * 3.5;
const ASSISTANT_ROW_HORIZONTAL_PADDING = 3.5;
// Let neighboring rows move out of the new rows' space before showing their text.
const THREAD_FEED_DISCLOSURE_ENTER_TRANSITION = FadeIn.delay(
  THREAD_DISCLOSURE_TRANSITION_MS,
).duration(140);

// Entering animations must only play for rows born just now — LegendList
// remounts rows when they scroll back into view, and replaying an entrance for
// old content would be its own kind of jank.
const FRESH_ENTRY_WINDOW_MS = 3_000;
function isFreshTimestamp(input: string): boolean {
  const timestamp = Date.parse(input);
  return Number.isFinite(timestamp) && Date.now() - timestamp < FRESH_ENTRY_WINDOW_MS;
}

export interface ThreadFeedHistoryControls {
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onLoadEarlier: () => void;
}

export interface ThreadFeedProps {
  readonly worktreeSetup?: WorktreeSetupCardProps | null;
  readonly setupWorkingStartedAt?: string | null;
  readonly queuedMessages: ReadonlyArray<QueuedThreadMessage>;
  readonly dispatchingMessageId: MessageId | null;
  readonly steerWait?: SteerWait | null;
  readonly onSendSteerNow?: (toolItemIds: ReadonlyArray<TurnItemId>) => Promise<void>;
  /** Null where a pending message cannot be edited (no composer to edit it in). */
  readonly onEditPendingMessage: ((message: QueuedThreadMessage) => void) | null;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly draftKey: string | null;
  readonly canOperateMessage: boolean;
  readonly supportsRollback: boolean;
  readonly messageRunActive: boolean;
  readonly rewindInProgress: boolean;
  readonly onRewindingChange: (rewinding: boolean) => void;
  readonly workspaceRoot?: string | null;
  readonly feed: ReadonlyArray<ThreadFeedEntry>;
  readonly mediaJump?: { readonly item: TimelineJumpTarget; readonly sequence: number } | null;
  readonly onMediaJumpHandled?: ((sequence: number) => void) | undefined;
  readonly pendingHandoff?: HandoffEndpoints | null;
  readonly contentPresentation: ThreadContentPresentation;
  readonly agentLabel: string;
  readonly agentDriver?: string | null;
  readonly agentAvatars?: ReadonlyMap<string, ReturnType<typeof discordAvatarIdentity>> | undefined;
  readonly visitedAtOpen?: string | null;
  readonly latestRun: ThreadFeedLatestRun | null;
  readonly activeWorkStartedAt: string | null;
  readonly runlessWorkActive?: boolean;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly freeze: SharedValue<boolean>;
  readonly anchorMessageId: MessageId | null;
  readonly submittedMessageId: MessageId | null;
  readonly contentInsetEndAdjustment: SharedValue<number>;
  readonly contentTopInset?: number;
  readonly contentBottomInset?: number;
  readonly historyControls?: ThreadFeedHistoryControls;
  readonly contentMaxWidth?: number;
  readonly contentSideInsets?: { readonly left: number; readonly right: number };
  readonly layoutVariant?: LayoutVariant;
  readonly usesAutomaticContentInsets?: boolean;
  readonly onHeaderMaterialVisibilityChange?: (visible: boolean) => void;
  readonly onEndFollowEnabledChange?: (enabled: boolean) => void;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
  readonly onUseArtifactTemplate?: (template: CodexArtifactTemplate) => void;
  readonly onQuoteMessage?: ((text: string) => void) | undefined;
}

async function waitForThreadShell(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): Promise<boolean> {
  const atom = environmentThreadShells.threadShellAtom(scopeThreadRef(environmentId, threadId));
  return waitForThreadShellReady({
    read: () => appAtomRegistry.get(atom) !== null,
  });
}

/** Pins this agent message to the chat's pinned messages (the header's pin), or unpins it. */
function AssistantPinButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly iconColor: ColorValue;
}) {
  const thread = useThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const setPin = useAtomCommand(threadEnvironment.pinMessage, "pin message");
  const pinned = thread?.pinnedMessages?.some((pin) => pin.messageId === props.messageId) ?? false;
  if (thread === null) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={pinned ? "Unpin message" : "Pin message"}
      accessibilityState={{ selected: pinned }}
      onPress={() => {
        void Haptics.selectionAsync();
        void setPin({
          environmentId: props.environmentId,
          input: {
            threadId: props.threadId,
            messageId: props.messageId,
            pinned: !pinned,
            text: props.text,
          },
        });
      }}
      className="h-7 w-7 items-center justify-center"
    >
      <SymbolView
        name={pinned ? "pin.fill" : "pin"}
        size={13}
        tintColor={props.iconColor}
        type="monochrome"
      />
    </Pressable>
  );
}

function AssistantForkButton(props: {
  readonly environmentId: EnvironmentId;
  readonly iconColor: ColorValue;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly sourceTitle: string;
}) {
  const support = useV2ItemSupport({
    environmentId: props.environmentId,
    sourceThreadId: props.projectedItem.sourceThreadId,
    sourceItemId: props.projectedItem.sourceItemId,
  });
  const forkFromRun = useAtomCommand(threadEnvironment.forkFromRun, "fork from response");
  const navigation = useNavigation();
  const [busy, setBusy] = useState(false);
  const canFork = canForkProjectedAssistantItem({
    projectedItem: props.projectedItem,
    capabilities: support.providerSession?.capabilities,
  });
  const runId = props.projectedItem.item.runId;

  if (!canFork || runId === null) return null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Fork from this response"
      disabled={busy}
      onPress={() => {
        const targetThreadId = ThreadId.make(uuidv4());
        setBusy(true);
        void Haptics.selectionAsync();
        void forkFromRun({
          environmentId: props.environmentId,
          input: {
            sourceThreadId: props.projectedItem.sourceThreadId,
            targetThreadId,
            runId,
            title: `${props.sourceTitle} fork`,
            creationSource: "mobile",
          },
        })
          .then(async (result) => {
            if (result._tag !== "Success") return;
            const targetThreadReady = await waitForThreadShell(props.environmentId, targetThreadId);
            if (!targetThreadReady) {
              Alert.alert(
                "Fork created",
                "Its chat data did not reach this client. Reconnect and try opening it from the chat list.",
              );
              return;
            }
            navigation.navigate("Thread", {
              environmentId: props.environmentId,
              threadId: targetThreadId,
            });
          })
          .finally(() => setBusy(false));
      }}
      className="h-7 w-7 items-center justify-center disabled:opacity-40"
    >
      {busy ? (
        <AppActivityIndicator size="small" />
      ) : (
        <SymbolView
          name="arrow.triangle.branch"
          size={13}
          tintColor={props.iconColor}
          type="monochrome"
        />
      )}
    </Pressable>
  );
}

function MessageAttachmentImage(props: {
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly original?: ChatImageOriginal;
  readonly sentSize?: ImageAttachmentDimensions;
  readonly className: string;
  /** Pixel size for grid tiles, which a class name cannot carry. */
  readonly size?: number;
  readonly onPressPreview: (source: FilePreviewSource) => void;
}) {
  const withGallery = useFilePreviewGallery();
  const sourceIdentifier = useId();
  const resource = useMemo(
    () => ({
      _tag: "attachment" as const,
      attachmentId: props.attachmentId,
      fileName: props.name,
      mimeType: props.mimeType,
    }),
    [props.attachmentId, props.name, props.mimeType],
  );
  const uri = useAssetUrl(props.environmentId, resource);
  const refreshAssetUrl = useRefreshAssetUrl(props.environmentId, resource);
  const retriedImage = useRef(false);
  const imageStyle = useResolveClassNames(props.className);
  const actionsSource = useMemo(
    () => ({
      name: props.name,
      mimeType: props.mimeType,
      environmentId: props.environmentId,
      resource,
      ...(props.original ? { original: { ...props.original, sentSize: props.sentSize } } : {}),
    }),
    [props.name, props.mimeType, props.environmentId, resource, props.original, props.sentSize],
  );
  const mediaActions = useMediaActions(actionsSource);

  const sizeStyle = props.size === undefined ? null : { width: props.size, height: props.size };

  if (uri === null) {
    return (
      <View className={`${props.className} items-center justify-center`} style={sizeStyle}>
        <AppActivityIndicator />
      </View>
    );
  }

  return (
    <PresentationSource identifier={sourceIdentifier}>
      <MediaActionsMenu media={mediaActions}>
        <Pressable
          accessibilityRole="imagebutton"
          accessibilityLabel={`Open ${props.name}`}
          accessibilityHint="Touch and hold for media actions"
          onPress={() =>
            // The viewer mints its own URL from the resource so the image survives a refresh.
            props.onPressPreview(
              withGallery({
                kind: "image",
                environmentId: props.environmentId,
                resource,
                name: props.name,
                sourceIdentifier,
                actionsSource,
              }),
            )
          }
        >
          <ExpoImage
            source={assetImageSource(props.environmentId, resource, uri)}
            cachePolicy="memory-disk"
            style={[imageStyle, sizeStyle]}
            contentFit="cover"
            onLoad={() => {
              retriedImage.current = false;
            }}
            onError={() => {
              if (retriedImage.current) return;
              retriedImage.current = true;
              void refreshAssetUrl();
            }}
          />
          <MediaActionFeedbackBadge feedback={mediaActions.feedback} />
        </Pressable>
      </MediaActionsMenu>
    </PresentationSource>
  );
}

/** Several pictures in one message: a strip of thumbnails instead of a stack of full-width images. */
function MessageAttachmentImageStrip(props: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<ChatImageAttachment>;
  readonly onPressPreview: (source: FilePreviewSource) => void;
}) {
  const items = useMemo(
    () =>
      props.attachments.map((attachment): ThreadImageStripItem => {
        const resource = {
          _tag: "attachment" as const,
          attachmentId: attachment.id,
          fileName: attachment.name,
          mimeType: attachment.mimeType,
        };
        return {
          key: attachment.id,
          name: attachment.name,
          preview: {
            kind: "image",
            name: attachment.name,
            environmentId: props.environmentId,
            resource,
          },
          actionsSource: {
            name: attachment.name,
            mimeType: attachment.mimeType,
            environmentId: props.environmentId,
            resource,
            ...(attachment.original
              ? { original: { ...attachment.original, sentSize: attachment.sentSize } }
              : {}),
          },
        };
      }),
    [props.attachments, props.environmentId],
  );
  return (
    <ThreadImageStrip
      items={items}
      height={MESSAGE_IMAGE_STRIP_HEIGHT}
      onPressPreview={props.onPressPreview}
      className="mt-1.5"
    />
  );
}

// The attachment union has an open member (`type: string` for attachment
// types from newer servers), so literal comparisons do not narrow it. Split
// with guards and render unknown types as inert rows, never crash.
function isImageAttachment(attachment: ChatAttachment): attachment is ChatImageAttachment {
  // Messages sent before pictures were typed by content carry `file`; they are still
  // pictures, and reading them as such is what lets them keep their thumbnail.
  return attachment.type === "image" || imageMimeType(attachment) !== null;
}

function isFileAttachment(attachment: ChatAttachment): attachment is ChatFileAttachment {
  return attachment.type === "file";
}

function MessageAttachmentFile(props: {
  readonly environmentId: EnvironmentId;
  readonly attachment: ChatFileAttachment;
  readonly onPressPreview: (source: FilePreviewSource) => void;
  readonly onPressVideo: (attachment: ChatFileAttachment, sourceIdentifier: string) => void;
}) {
  const sourceIdentifier = useId();
  const navigation = useNavigation();
  const { selectedThread } = useThreadSelection();
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    refresh: true,
    reportFailure: false,
  });
  const preparedConnection = usePreparedConnection(props.environmentId);
  const { attachment } = props;
  const videoType = videoMimeType(attachment);
  const isPdf = isPdfFile(attachment);
  const fileTypeLabel = isPdf
    ? "PDF"
    : (attachment.name.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toUpperCase() ?? "File");
  const sizeLabel = formatAttachmentSize(attachment.sizeBytes);
  const thumbnailUrl = useAssetUrl(
    props.environmentId,
    videoType === null
      ? null
      : {
          _tag: "attachment",
          attachmentId: attachment.id,
          fileName: attachment.name,
          mimeType: videoType,
        },
  );
  const httpBaseUrl = Option.isSome(preparedConnection)
    ? preparedConnection.value.httpBaseUrl
    : null;
  const openingRef = useRef<AbortController | null>(null);
  const [opening, setOpening] = useState(false);

  useFocusEffect(
    useCallback(() => {
      setOpening(false);
      return () => {
        openingRef.current?.abort();
        openingRef.current = null;
      };
    }, [props.environmentId, attachment.id, httpBaseUrl]),
  );

  const shareFile = (sourceIdentifier?: string) => {
    if (httpBaseUrl === null || openingRef.current) return;
    const controller = new AbortController();
    openingRef.current = controller;
    setOpening(true);
    void (async () => {
      try {
        const result = await createAssetUrl({
          environmentId: props.environmentId,
          input: {
            resource: {
              _tag: "attachment",
              attachmentId: attachment.id,
              fileName: attachment.name,
              mimeType: attachment.mimeType,
            },
          },
        });
        if (controller.signal.aborted) return;
        if (result._tag === "Failure") {
          throw squashAtomCommandFailure(result);
        }
        const url = resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
        if (url === null) {
          throw new Error("The attachment could not be opened.");
        }
        await downloadAndShareAttachment({
          url,
          attachment,
          signal: controller.signal,
          sourceIdentifier,
        });
      } catch (error) {
        if (!controller.signal.aborted) {
          Alert.alert(
            "Could not open attachment",
            error instanceof Error ? error.message : "The attachment is unavailable.",
          );
        }
      } finally {
        if (openingRef.current === controller) {
          openingRef.current = null;
          setOpening(false);
        }
      }
    })();
  };

  if (videoType !== null) {
    const sourceIdentifier = `attachment:${props.environmentId}:${attachment.id}`;
    return (
      <VideoAttachmentTile
        name={attachment.name}
        sourceIdentifier={sourceIdentifier}
        thumbnailSource={thumbnailUrl}
        actionsSource={
          attachmentVideoPreviewSource(props.environmentId, attachment, sourceIdentifier)
            .actionsSource
        }
        disabled={opening || httpBaseUrl === null}
        onPress={(sourceIdentifier) => props.onPressVideo(attachment, sourceIdentifier)}
        className="my-1 rounded-2xl"
        style={{ width: 224, maxWidth: "100%", aspectRatio: 16 / 9 }}
      />
    );
  }

  return (
    <>
      <PresentationSource
        identifier={sourceIdentifier}
        className="my-1"
        style={{ width: 280, maxWidth: "100%" }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${attachment.name}`}
          accessibilityValue={{ text: `${fileTypeLabel}, ${sizeLabel}` }}
          accessibilityState={{ disabled: opening || httpBaseUrl === null, busy: opening }}
          disabled={opening || httpBaseUrl === null}
          className="min-w-0 flex-row items-center gap-3 rounded-xl border border-border bg-card p-3 active:bg-subtle"
          onLongPress={() => shareFile(sourceIdentifier)}
          onPress={() =>
            isPdf
              ? props.onPressPreview({
                  kind: "pdf",
                  name: attachment.name,
                  environmentId: props.environmentId,
                  resource: {
                    _tag: "attachment",
                    attachmentId: attachment.id,
                    fileName: attachment.name,
                    mimeType: "application/pdf",
                  },
                  sourceIdentifier,
                })
              : navigation.navigate("ThreadAttachment", {
                  environmentId: String(props.environmentId),
                  ...(selectedThread ? { threadId: String(selectedThread.id) } : {}),
                  attachmentId: attachment.id,
                  name: attachment.name,
                  mimeType: attachment.mimeType,
                  sizeBytes: String(attachment.sizeBytes),
                })
          }
        >
          <View className="h-12 w-10 shrink-0 items-center justify-center rounded-lg bg-subtle">
            {opening ? (
              <AppActivityIndicator size="small" />
            ) : (
              <PierreEntryIcon path={attachment.name} kind="file" size={26} />
            )}
          </View>
          <View className="min-w-0 flex-1 gap-1">
            <Text className="font-t3-medium text-sm text-foreground" numberOfLines={2}>
              {attachment.name}
            </Text>
            <Text className="text-xs text-foreground-muted" numberOfLines={1}>
              {fileTypeLabel} · {sizeLabel}
            </Text>
          </View>
          <SymbolView
            name="chevron.right"
            size={12}
            tintColorClassName="accent-foreground-muted"
            type="monochrome"
          />
        </Pressable>
      </PresentationSource>
    </>
  );
}

/**
 * An attachment type this build does not know (newer server). Rendered as an
 * inert row: the name is still useful, but there is nothing to open.
 */
function MessageAttachmentUnknown(props: { readonly name: string }) {
  return (
    <View className="flex-row items-center gap-2 py-1">
      <PierreEntryIcon path={props.name} kind="file" size={16} />
      <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
        {props.name}
      </Text>
    </View>
  );
}

// LegendList only computes hook visibility when the list has a viewability config.
const THREAD_MEDIA_VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 0 };

function ThreadMediaVisibility(props: { readonly children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  useViewabilityAmount<ThreadFeedEntry>(
    useCallback((token) => setVisible(token.sizeVisible > 0), []),
  );
  return <ThreadMediaVisibleContext value={visible}>{props.children}</ThreadMediaVisibleContext>;
}

interface MarkdownLinkHandlers {
  readonly onLinkPress: (href: string) => void;
  readonly fileContextMenu: (href: string) => MarkdownFileContextMenu | undefined;
  readonly onFileContextMenuAction: (href: string, actionId: string) => void;
  readonly onImagePress?: (href: string) => void;
  readonly resolveImageSource?: MarkdownImageSourceResolver;
  readonly linkCustomization?: (href: string) => MarkdownLinkCustomization | undefined;
}

interface MarkdownStyleSets {
  readonly user: MarkdownStyleSet;
  readonly assistant: MarkdownStyleSet;
}

interface MarkdownStyleSet {
  readonly nativeTextStyle: NativeMarkdownTextStyle;
}

const ARTIFACT_TEMPLATE_SYMBOL_BY_KIND: Record<
  CodexArtifactTemplate["artifactKind"],
  AppSymbolName
> = {
  document: "doc.text",
  presentation: "chart.bar.xaxis",
  spreadsheet: "chart.bar.xaxis",
  site: "safari",
  "google-docs": "doc.text",
  "google-slides": "chart.bar.xaxis",
  "google-sheets": "chart.bar.xaxis",
  image: "camera",
  email: "text.bubble",
  slack: "text.bubble",
};

function ArtifactTemplateCard(props: {
  readonly template: CodexArtifactTemplate;
  readonly onUse?: ((template: CodexArtifactTemplate) => void) | undefined;
}) {
  return (
    <View className="my-2 min-w-0 flex-row items-center gap-3 rounded-2xl border border-border bg-card px-3 py-3">
      <View className="relative h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-subtle">
        <SymbolView
          name={ARTIFACT_TEMPLATE_SYMBOL_BY_KIND[props.template.artifactKind]}
          size={20}
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
        />
        <View className="absolute -right-1 -bottom-1 h-4 w-4 items-center justify-center rounded-full bg-fuchsia-500">
          <SymbolView
            name={{ ios: "sparkles", android: "auto_awesome" }}
            size={9}
            tintColor="white"
            type="monochrome"
          />
        </View>
      </View>
      <View className="min-w-0 flex-1">
        <Text className="font-t3-bold text-sm text-foreground" numberOfLines={1}>
          {props.template.displayName}
        </Text>
        <Text className="text-xs text-foreground-muted">
          {codexArtifactTemplatePresentationLabel(props.template.artifactKind)}
        </Text>
      </View>
      {props.onUse ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Use ${props.template.displayName} template`}
          className="min-h-9 justify-center rounded-lg border border-border bg-subtle px-3 active:opacity-65"
          onPress={() => props.onUse?.(props.template)}
        >
          <Text className="font-t3-bold text-xs text-foreground">Use template</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Renders a markdown image; `scope` keys its asset URL to one message. */
type ScopedMarkdownImageRenderer = (
  image: Parameters<MarkdownImageRenderer>[0],
  scope?: string,
) => ReactNode;
type ScopedMarkdownImageGroupRenderer = (
  images: ReadonlyArray<MarkdownImageReference>,
  scope?: string,
) => ReactNode;

type AssistantMarkdownSegment = { readonly key: string } & (
  | MarkdownImageGroupSegment
  | Extract<
      ReturnType<typeof splitCodexArtifactTemplateMarkdown>[number],
      { readonly kind: "artifact-template" }
    >
);

const AssistantMarkdownContent = memo(function AssistantMarkdownContent(props: {
  readonly displayOnly?: boolean;
  readonly markdown: string;
  readonly isStreaming?: boolean;
  readonly environmentId: EnvironmentId;
  readonly markdownStyles: MarkdownStyleSet;
  readonly linkHandlers: MarkdownLinkHandlers;
  readonly onUseArtifactTemplate?: ((template: CodexArtifactTemplate) => void) | undefined;
  readonly renderImage: ScopedMarkdownImageRenderer;
  readonly renderImageGroup: ScopedMarkdownImageGroupRenderer;
  /** The message's id: its workspace images keep their own URLs, so a file the agent
      rewrote under the same name shows its new contents here, not a cached copy. */
  readonly assetScope?: string | undefined;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill> | undefined;
}) {
  const models = useModelMentions(props.environmentId, props.markdown);
  const liveMarkdown = useLiveThreadLinkLabels(props.markdown, props.environmentId);
  const { renderImage: renderScopedImage, assetScope } = props;
  const renderImage = useCallback<MarkdownImageRenderer>(
    (image) => renderScopedImage(image, assetScope),
    [renderScopedImage, assetScope],
  );
  // Images sharing a line or a paragraph with text would draw as native inline glyphs;
  // lift them into block images and thumbnail strips between the text segments.
  const segments = useMemo(
    () =>
      splitCodexArtifactTemplateMarkdown(liveMarkdown).flatMap(
        (segment): AssistantMarkdownSegment[] =>
          segment.kind === "artifact-template"
            ? [{ ...segment, key: `artifact-template:${segment.sourceOffset}` }]
            : splitMarkdownImageGroups(renderCodexInlineDirectivesAsMarkdown(segment.markdown)).map(
                (part) => ({
                  ...part,
                  key: `${part.kind}:${segment.sourceOffset}.${part.sourceOffset}`,
                }),
              ),
      ),
    [liveMarkdown],
  );

  return segments.map((segment) => {
    if (segment.kind === "artifact-template") {
      return (
        <ArtifactTemplateCard
          key={segment.key}
          template={segment.template}
          onUse={props.onUseArtifactTemplate}
        />
      );
    }
    if (segment.kind === "images") {
      return (
        <View key={segment.key} className="mb-2">
          {props.renderImageGroup(segment.images, assetScope)}
        </View>
      );
    }
    if (segment.markdown.trim().length === 0) return null;

    return (
      <SelectableMarkdownText
        key={segment.key}
        markdown={segment.markdown}
        displayOnly={props.displayOnly}
        isStreaming={props.isStreaming}
        skills={props.skills}
        models={models}
        textStyle={props.markdownStyles.nativeTextStyle}
        // Single line breaks stay, as in user messages and the Claude and ChatGPT apps.
        preserveSoftBreaks
        {...props.linkHandlers}
        renderImage={renderImage}
      />
    );
  });
});

function useMarkdownStyles(): MarkdownStyleSets {
  const harnessProseStyle = useHarnessProseStyle();
  const { appearance, harnessThemePreset } = useAppearancePreferences();
  const discord = harnessThemePreset?.id === "discord";
  const nativeMarkdownTypography = useMemo(
    () =>
      discord
        ? { ...resolveNativeMarkdownTypography(16), fontSize: 16, lineHeight: 22 }
        : resolveNativeMarkdownTypography(appearance.baseFontSize),
    [appearance.baseFontSize, discord],
  );
  const theme = useUniwindTheme();
  const markdownBodyColor = theme["--color-md-body"];
  const markdownStrongColor = theme["--color-md-strong"];
  const markdownLinkColor = theme["--color-md-link"];
  const markdownBlockquoteBorder = theme["--color-md-blockquote-border"];
  const markdownCodeBg = theme["--color-md-code-bg"];
  const markdownCodeText = theme["--color-md-code-text"];
  const markdownInlineCodeText = theme["--color-foreground-secondary"];
  const markdownHrColor = theme["--color-md-hr"];
  // Native chip drawing parses opaque hex only, and this role is translucent.
  const contextChipBorderColor = flattenThemeColor(
    theme["--color-border"],
    theme["--color-user-bubble"],
  );
  const markdownUserBodyColor = theme["--color-user-bubble-foreground"];
  const markdownUserCodeBg = theme["--color-md-user-code-bg"];
  const markdownUserCodeText = theme["--color-md-user-code-text"];
  const markdownUserInlineCodeText = theme["--color-user-bubble-foreground-muted"];
  const markdownUserFenceBg = theme["--color-md-user-fence-bg"];
  const inlineSkillForeground = theme["--color-inline-skill-foreground"];
  const userBubbleSkillForeground = theme["--color-user-bubble-skill-foreground"];
  const regularFontFamily = useFontFamily("regular");
  const boldFontFamily = useFontFamily("bold");

  return useMemo(() => {
    return {
      user: {
        nativeTextStyle: {
          color: markdownUserBodyColor,
          strongColor: markdownUserBodyColor,
          mutedColor: markdownUserBodyColor,
          linkColor: markdownUserBodyColor,
          inlineCodeColor: markdownUserInlineCodeText,
          codeColor: markdownUserCodeText,
          codeBackgroundColor: markdownUserCodeBg,
          codeBlockBackgroundColor: markdownUserFenceBg,
          fileTextColor: markdownUserBodyColor,
          skillTextColor: userBubbleSkillForeground,
          quoteMarkerColor: markdownUserBodyColor,
          dividerColor: markdownUserBodyColor,
          contextChipBorderColor,
          fontSize: nativeMarkdownTypography.fontSize,
          lineHeight: nativeMarkdownTypography.lineHeight,
          headingFontSizes: nativeMarkdownTypography.headingFontSizes,
          fontFamily: regularFontFamily,
          headingFontFamily: boldFontFamily,
          boldFontFamily,
        },
      },
      assistant: {
        nativeTextStyle: {
          color: markdownBodyColor,
          strongColor: markdownStrongColor,
          mutedColor: markdownBodyColor,
          linkColor: markdownLinkColor,
          inlineCodeColor: markdownInlineCodeText,
          codeColor: markdownCodeText,
          codeBackgroundColor: markdownCodeBg,
          codeBlockBackgroundColor: markdownCodeBg,
          fileTextColor: markdownCodeText,
          skillTextColor: inlineSkillForeground,
          quoteMarkerColor: markdownBlockquoteBorder,
          dividerColor: markdownHrColor,
          contextChipBorderColor,
          fontSize: nativeMarkdownTypography.fontSize,
          lineHeight: nativeMarkdownTypography.lineHeight,
          headingFontSizes: nativeMarkdownTypography.headingFontSizes,
          fontFamily: regularFontFamily,
          headingFontFamily: boldFontFamily,
          boldFontFamily,
          ...harnessProseStyle,
        },
      },
    };
  }, [
    harnessProseStyle,
    boldFontFamily,
    contextChipBorderColor,
    inlineSkillForeground,
    markdownBlockquoteBorder,
    markdownBodyColor,
    markdownCodeBg,
    markdownCodeText,
    markdownHrColor,
    markdownInlineCodeText,
    markdownLinkColor,
    markdownStrongColor,
    markdownUserBodyColor,
    markdownUserCodeBg,
    markdownUserCodeText,
    markdownUserFenceBg,
    markdownUserInlineCodeText,
    nativeMarkdownTypography,
    regularFontFamily,
    userBubbleSkillForeground,
  ]);
}

const AGENT_MESSAGE_BODY_INSET = 32;

/** A tool-style row that folds a message; the full message opens beneath it. */
function FoldedMessageRow(props: {
  readonly children: ReactNode;
  readonly anchorKey: string;
  readonly symbolName: AppSymbolName;
  readonly symbolTintClassName: string;
  readonly label: string;
  readonly preview: string;
  readonly status?: string | null;
  readonly accessibilityLabel: string;
  readonly timestampLabel: string;
  readonly rowSizing: ReturnType<typeof deriveThreadWorkLogSizing>;
  readonly iconSubtleColor: ColorValue;
  readonly onToggle: (anchorKey: string) => void;
  readonly onDisclosureLayout: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const previousExpanded = useRef(expanded);
  const onDisclosureLayout = props.onDisclosureLayout;

  useLayoutEffect(() => {
    if (previousExpanded.current !== expanded) {
      previousExpanded.current = expanded;
      onDisclosureLayout();
    }
  }, [expanded, onDisclosureLayout]);

  return (
    <WorkLogBlock>
      <WorkLogPressable
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel}
        accessibilityState={{ expanded }}
        accessibilityHint={`Double tap to ${expanded ? "hide" : "show"} the full message.`}
        rowSizing={props.rowSizing}
        onPress={() => {
          void Haptics.selectionAsync();
          props.onToggle(props.anchorKey);
          setExpanded((current) => !current);
        }}
      >
        <WorkLogIconSlot>
          <SymbolView
            name={props.symbolName}
            size={18}
            tintColorClassName={props.symbolTintClassName}
            type="monochrome"
          />
        </WorkLogIconSlot>
        <WorkLogLabel>
          <Text className="font-t3-medium text-foreground-muted">{props.label}</Text>
          {props.preview ? (
            <Text className="text-foreground-subtle">{`  ${props.preview}`}</Text>
          ) : null}
        </WorkLogLabel>
        {props.status ? (
          <Text
            className={cn(
              "rounded px-1 py-0.5 text-2xs",
              props.status === "failed"
                ? "bg-danger-foreground/10 text-danger-foreground"
                : "bg-subtle text-foreground-muted",
            )}
          >
            {props.status}
          </Text>
        ) : null}
        <Text className="text-2xs tabular-nums text-foreground-subtle">{props.timestampLabel}</Text>
        <ThreadDisclosureChevron
          expanded={expanded}
          collapsedDirection="down"
          size={11}
          tintColor={props.iconSubtleColor}
        />
      </WorkLogPressable>
      {expanded ? (
        <View className="pb-1 pt-2" style={{ paddingLeft: AGENT_MESSAGE_BODY_INSET }}>
          {props.children}
        </View>
      ) : null}
    </WorkLogBlock>
  );
}

function AgentMessageRow(props: {
  readonly children: ReactNode;
  readonly anchorKey: string;
  readonly environmentId: EnvironmentId;
  readonly senderThreadId?: ThreadId;
  readonly text: string;
  readonly inputIntent?: OrchestrationV2UserMessageInputIntent;
  readonly status?: OrchestrationV2TurnItemStatus;
  readonly timestampLabel: string;
  readonly rowSizing: ReturnType<typeof deriveThreadWorkLogSizing>;
  readonly iconSubtleColor: ColorValue;
  readonly onToggle: (anchorKey: string) => void;
  readonly onDisclosureLayout: () => void;
}) {
  const navigation = useNavigation();
  const senderThreadId = props.senderThreadId;
  const sender = useThreadShell(
    senderThreadId ? scopeThreadRef(props.environmentId, senderThreadId) : null,
  );
  const presentation = resolveAgentMessagePresentation({
    text: props.text,
    senderTitle: sender?.title,
    inputIntent: props.inputIntent,
    status: props.status,
  });

  return (
    <FoldedMessageRow
      anchorKey={props.anchorKey}
      symbolName="bubble.left.and.bubble.right"
      symbolTintClassName="accent-adaptive-sky-600-400"
      label={presentation.label}
      preview={presentation.preview}
      status={presentation.status}
      accessibilityLabel={presentation.accessibilityLabel}
      timestampLabel={props.timestampLabel}
      rowSizing={props.rowSizing}
      iconSubtleColor={props.iconSubtleColor}
      onToggle={props.onToggle}
      onDisclosureLayout={props.onDisclosureLayout}
    >
      {props.children}
      {senderThreadId ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open sending chat"
          hitSlop={4}
          className="mt-1 self-start rounded-md py-1 active:bg-subtle"
          onPress={() =>
            navigation.navigate("Thread", {
              environmentId: String(props.environmentId),
              threadId: String(senderThreadId),
            })
          }
        >
          <Text className="font-t3-medium text-2xs text-foreground-muted">Open sending chat</Text>
        </Pressable>
      ) : null}
    </FoldedMessageRow>
  );
}

/** The user's answer to an `ask_user` card, folded to a tool-style row. */
function AnsweredQuestionRow(props: {
  readonly anchorKey: string;
  readonly environmentId: EnvironmentId;
  readonly answer: UserInputAttachmentAnswerPayload | undefined;
  readonly text: string;
  readonly timestampLabel: string;
  readonly rowSizing: ReturnType<typeof deriveThreadWorkLogSizing>;
  readonly iconSubtleColor: ColorValue;
  readonly onToggle: (anchorKey: string) => void;
  readonly onDisclosureLayout: () => void;
}) {
  const presentation = resolveAnsweredQuestionPresentation({
    answer: props.answer,
    text: props.text,
  });
  return (
    <FoldedMessageRow
      anchorKey={props.anchorKey}
      symbolName="questionmark.bubble"
      symbolTintClassName="accent-foreground-muted"
      label={presentation.label}
      preview={presentation.preview}
      accessibilityLabel={presentation.accessibilityLabel}
      timestampLabel={props.timestampLabel}
      rowSizing={props.rowSizing}
      iconSubtleColor={props.iconSubtleColor}
      onToggle={props.onToggle}
      onDisclosureLayout={props.onDisclosureLayout}
    >
      {props.answer ? (
        <QuestionAnswerHistory environmentId={props.environmentId} answer={props.answer} />
      ) : (
        <Text className="text-sm text-foreground-muted">{props.text}</Text>
      )}
    </FoldedMessageRow>
  );
}

/**
 * Under a steer the agent hasn't read: what it waits behind and for how long.
 * Claude can move the running calls to the background so the agent reads the steer now.
 */
function SteerWaitLine({
  wait,
  onSendNow,
}: {
  readonly wait: SteerWait;
  readonly onSendNow?: (toolItemIds: ReadonlyArray<TurnItemId>) => Promise<void>;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [sending, setSending] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <View className="mt-1 max-w-full flex-row items-center justify-end gap-2 pr-0.5">
      <Text
        numberOfLines={1}
        className="flex-1 text-right text-xs tabular-nums text-foreground-muted"
      >
        Waiting for {wait.label} to finish · {formatSteerWaitElapsed(nowMs - wait.startedAtMs)}
      </Text>
      {wait.sendNowToolItemIds.length > 0 && onSendNow ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send now"
          accessibilityHint={
            wait.toolCount > 1
              ? "They keep running in the background, and the agent reads your message now."
              : "The command keeps running in the background, and the agent reads your message now."
          }
          disabled={sending}
          hitSlop={8}
          onPress={() => {
            setSending(true);
            void onSendNow(wait.sendNowToolItemIds).finally(() => setSending(false));
          }}
          className="rounded-full border border-border bg-secondary px-2 py-0.5 active:opacity-70"
        >
          <Text className="font-t3-medium text-xs text-foreground-secondary">
            {sending ? "Sending…" : "Send now"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** "Opus 5.5 → Sonnet 5.5" above the message or wake notification that started the first run on it. */
function FeedEntryModelSwitchDivider(props: {
  entry: PendingThreadFeedEntry;
  environmentId: EnvironmentId;
  iconColor: ColorValue;
}) {
  const { entry } = props;
  const item =
    entry.type === "message"
      ? entry.message.text.trim().toLowerCase() === "/compact"
        ? undefined
        : entry.message.projectedItem?.item
      : entry.type === "activity-group" && entry.activities.length === 1
        ? entry.activities[0]?.projectedItem.item
        : undefined;
  const modelSwitch =
    item?.type === "user_message" || item?.type === "notification" ? item.modelSwitch : undefined;
  return modelSwitch === undefined ? null : (
    <ThreadModelSwitchDivider
      environmentId={props.environmentId}
      modelSwitch={modelSwitch}
      iconColor={props.iconColor}
    />
  );
}

function renderFeedEntry(
  info: { item: PendingThreadFeedEntry; index: number },
  props: Pick<
    ThreadFeedProps,
    | "environmentId"
    | "agentLabel"
    | "onUseArtifactTemplate"
    | "onQuoteMessage"
    | "skills"
    | "dispatchingMessageId"
    | "steerWait"
    | "onSendSteerNow"
    | "onEditPendingMessage"
    | "threadId"
    | "workspaceRoot"
    | "draftKey"
    | "canOperateMessage"
    | "supportsRollback"
    | "messageRunActive"
    | "rewindInProgress"
    | "onRewindingChange"
  > & {
    readonly copiedRowId: string | null;
    readonly expandedWorkRows: Record<string, boolean>;
    readonly workRowSizing: ReturnType<typeof deriveThreadWorkLogSizing>;
    readonly workGroupScrollPositions: Map<string, ThreadWorkGroupScrollPosition>;
    readonly terminalAssistantMessageIds: ReadonlySet<string>;
    readonly unsettledTurnId: RunId | null;
    readonly failedRunIds: ReadonlySet<RunId>;
    readonly onCopyWorkRow: (rowId: string, value: string) => void;
    readonly onToggleWorkGroup: (groupId: string, anchorKey?: string) => void;
    readonly onToggleWorkRow: (rowId: string, anchorKey?: string, shownExpanded?: boolean) => void;
    readonly onToggleTurnFold: (runId: RunId) => void;
    readonly onToggleAgentMessage: (anchorKey: string) => void;
    readonly onDisclosureLayout: () => void;
    readonly onPressPreview: (source: FilePreviewSource) => void;
    readonly onPressVideo: (attachment: ChatFileAttachment, sourceIdentifier: string) => void;
    readonly markdownLinkHandlers: MarkdownLinkHandlers;
    readonly renderMarkdownImage: ScopedMarkdownImageRenderer;
    readonly renderMarkdownImageGroup: ScopedMarkdownImageGroupRenderer;
    readonly renderViewedImage: MarkdownImageRenderer;
    readonly renderReasoning: (text: string) => ReactNode;
    readonly iconSubtleColor: string | import("react-native").ColorValue;
    readonly screenColor: string;
    readonly userBubbleColor: string | import("react-native").ColorValue;
    readonly markdownStyles: MarkdownStyleSets;
    readonly reviewCommentColors: ReviewCommentColors;
    readonly reviewCommentBubbleWidth: number;
    readonly harnessView: HarnessThemeView | null;
    readonly discord: boolean;
    readonly casualVoice: boolean;
    readonly themeAppearance: "light" | "dark";
    readonly usesNativeWorkspaceColumns: boolean;
    readonly userBubbleMaxWidth: number;
    /** Width assistant markdown lays out in, so images can size their frame before layout. */
    readonly markdownContentWidth: number;
    /** Width full-bleed rows (HTML renders) lay out in. */
    readonly contentWidth: number;
    readonly threadTitle: string;
  },
) {
  const entry = info.item;
  const { markdownStyles, iconSubtleColor, userBubbleColor } = props;

  if (entry.type === "run-fold") {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: entry.expanded }}
        onPress={() => props.onToggleTurnFold(entry.runId)}
        hitSlop={4}
        className="mb-1 min-h-11 flex-row items-center gap-2 border-b border-border-subtle px-2"
        style={{
          minHeight: Math.max(TURN_FOLD_HEIGHT - 3.5, props.workRowSizing.estimatedRowHeight),
        }}
      >
        <Text
          key={props.workRowSizing.textSizeKey}
          className="font-t3-medium text-sm tabular-nums text-foreground-muted"
        >
          {entry.label}
        </Text>
        <ThreadDisclosureChevron
          expanded={entry.expanded}
          collapsedDirection="right"
          size={15}
          tintColor={iconSubtleColor}
        />
      </Pressable>
    );
  }

  if (entry.type === "thinking") {
    return (
      <ThreadWorkingRow
        rowSizing={props.workRowSizing}
        iconSubtleColor={iconSubtleColor}
        label={entry.label}
        shimmer={entry.shimmer === true}
      />
    );
  }

  if (entry.type === "viewed-images") {
    return (
      <ThreadWorkImageStrip
        activities={entry.activities}
        environmentId={props.environmentId}
        threadId={props.threadId}
        workspaceRoot={props.workspaceRoot}
        onPressPreview={props.onPressPreview}
      />
    );
  }

  if (entry.type === "html-render") {
    return (
      <ThreadHtmlRender
        environmentId={props.environmentId}
        threadId={props.threadId}
        render={entry.render}
        frameWidth={props.contentWidth}
        iconColor={iconSubtleColor}
      />
    );
  }

  if (entry.type === "mcp-app") {
    return (
      <ThreadMcpApp
        key={entry.app.attachmentId}
        environmentId={props.environmentId}
        threadId={entry.sourceThreadId}
        conversationThreadId={props.threadId}
        itemId={entry.itemId}
        revision={entry.revision}
        app={entry.app}
        width={props.contentWidth}
      />
    );
  }

  if (entry.type === "work-toggle") {
    const toggle = (
      <ThreadWorkGroupToggle
        environmentId={props.environmentId}
        rowSizing={props.workRowSizing}
        expanded={entry.expanded}
        hiddenCount={entry.hiddenCount}
        iconSubtleColor={iconSubtleColor}
        summary={entry.summary}
        summaryKind={entry.summaryKind}
        themeAppearance={props.themeAppearance}
        toolSurface={entry.toolSurface}
        toolIcon={entry.toolIcon}
        summaryToolIcon={entry.summaryToolIcon}
        hasFailure={entry.hasFailure}
        shimmer={entry.shimmer}
        onToggle={() => props.onToggleWorkGroup(entry.groupId, entry.id)}
      />
    );
    // Screenshots and viewed images stay visible without expanding the group.
    return (
      <>
        {toggle}
        {workGroupImageNotices(entry.activities).map((notice) => (
          <Text key={notice} className="mb-1 ml-8 text-sm text-foreground-muted">
            {notice}
          </Text>
        ))}
        {workGroupImageSources(entry.activities).length > 0 ? (
          <ThreadWorkImageStrip
            activities={entry.activities}
            environmentId={props.environmentId}
            threadId={props.threadId}
            workspaceRoot={props.workspaceRoot}
            onPressPreview={props.onPressPreview}
          />
        ) : null}
      </>
    );
  }

  if (entry.type === "activity-group" && isContextHandoffActivityGroup(entry)) {
    return (
      <ThreadHandoffRow
        environmentId={props.environmentId}
        projectedItem={entry.activities[0]!.projectedItem}
        iconColor={iconSubtleColor}
      />
    );
  }

  if (entry.type === "activity-group" && isSecretRequestActivityGroup(entry)) {
    return (
      <SecretRequestCard
        environmentId={props.environmentId}
        projectedItem={entry.activities[0]!.projectedItem}
        iconColor={iconSubtleColor}
      />
    );
  }

  if (entry.type === "activity-group" && isContextCompactionActivityGroup(entry)) {
    const label = entry.activities[0]!.summary;
    const active =
      props.unsettledTurnId !== null &&
      entry.runId === props.unsettledTurnId &&
      entry.activities[0]!.projectedItem.item.status === "running";
    return (
      <ThreadContextDivider
        label={label}
        icon="arrow.down.right.and.arrow.up.left"
        iconColor={iconSubtleColor}
        active={active}
      />
    );
  }

  if (entry.type === "message") {
    const { message } = entry;
    const isUser = message.role === "user";
    const presentation = resolveUserMessagePresentation(
      entry.pendingMessage
        ? { ...message, attachments: entry.pendingMessage.attachments }
        : message,
    );
    const renderedText = renderAssistantCitationsAsText(presentation.text);
    const styles = isUser ? markdownStyles.user : markdownStyles.assistant;
    const timestampLabel = formatTranscriptTimestamp(
      isUser ? message.createdAt : message.updatedAt,
    );
    const attachments = message.attachments ?? [];
    const hasReviewCommentContext = presentation.text.includes("<review_comment");
    // A bubble that sizes itself from its content cannot lay out a block whose
    // intrinsic width overflows `maxWidth`: Android positions the bubble's
    // children during the unclamped pass and never moves them once the width
    // is clamped, so the paragraphs around the block end up drawn on top of
    // each other. Pinning the width removes that pass.
    const hasWideBlock = hasWideMarkdownBlock(renderedText, WIDE_MARKDOWN_BLOCK_OPTIONS);
    const assistantTurnStillInProgress =
      message.role === "assistant" &&
      props.unsettledTurnId !== null &&
      message.runId === props.unsettledTurnId;
    const showAssistantMeta =
      message.role === "assistant" &&
      props.terminalAssistantMessageIds.has(message.id) &&
      !assistantTurnStillInProgress &&
      !message.streaming;

    if (isUser && (message.questionAnswer || message.id.startsWith("async-answer:"))) {
      return (
        <AnsweredQuestionRow
          key={entry.id}
          anchorKey={entry.id}
          environmentId={props.environmentId}
          answer={message.questionAnswer}
          text={message.text}
          timestampLabel={timestampLabel}
          rowSizing={props.workRowSizing}
          iconSubtleColor={iconSubtleColor}
          onToggle={props.onToggleAgentMessage}
          onDisclosureLayout={props.onDisclosureLayout}
        />
      );
    }

    if (isUser) {
      const isAgentMessage = presentation.attribution === "agent";
      const enterAnimated = !isAgentMessage && isFreshTimestamp(message.createdAt);
      // An agent message's bubble sits inset under its row, so its share of the
      // width (numeric, or the "85%" iPhone columns use) is of the inset width.
      const userBubbleMaxWidth = isAgentMessage
        ? props.contentWidth > 0
          ? (props.userBubbleMaxWidth *
              Math.max(0, props.contentWidth - AGENT_MESSAGE_BODY_INSET)) /
            props.contentWidth
          : 0
        : props.userBubbleMaxWidth;
      const intentBadge = resolveUserMessageIntentBadge(message.inputIntent);
      const referenceIds = new Set(
        collectComposerContextReferences(message.text).map((reference) => reference.contextId),
      );
      const inlineAttachmentIds = new Set(
        message.context?.records.flatMap((record) =>
          "attachmentId" in record && referenceIds.has(record.contextId)
            ? [record.attachmentId]
            : [],
        ),
      );
      const visibleAttachments = attachments.filter(
        (attachment) => isImageAttachment(attachment) || !inlineAttachmentIds.has(attachment.id),
      );
      // Several pictures, or pictures a context chip refers to, share a two-column grid.
      const attachmentImageTile =
        inlineAttachmentIds.size > 0 || visibleAttachments.filter(isImageAttachment).length > 1
          ? Math.min(
              160,
              Math.floor(
                (userBubbleMaxWidth -
                  (props.harnessView?.userBubble.paddingX ?? USER_BUBBLE_HORIZONTAL_PADDING) * 2 -
                  8) /
                  2,
              ),
            )
          : null;
      const bubble = (
        <Animated.View
          className={props.discord ? "items-stretch" : cn("items-end", !isAgentMessage && "mb-5")}
          style={
            props.harnessView && !isAgentMessage && !props.discord
              ? { marginBottom: props.harnessView.density === "comfortable" ? 22 : 14 }
              : undefined
          }
          {...(enterAnimated ? { entering: FadeInUp.duration(220) } : {})}
        >
          {presentation.attribution === "automation" ? (
            <Text className="mb-1 pr-1 font-t3-medium text-2xs text-foreground-muted opacity-60">
              Sent by automation
            </Text>
          ) : presentation.attribution === "t3code" ? (
            <Text className="mb-1 pr-1 font-t3-medium text-2xs text-foreground-muted opacity-60">
              Sent by SSHCode
            </Text>
          ) : null}
          <UserMessageBubble
            style={{
              backgroundColor: props.discord ? "transparent" : userBubbleColor,
              ...(props.discord
                ? { borderRadius: 0, paddingHorizontal: 0, paddingVertical: 0 }
                : props.harnessView
                  ? {
                      borderRadius: props.harnessView.userBubble.radius,
                      paddingHorizontal: props.harnessView.userBubble.paddingX,
                      paddingVertical: props.harnessView.userBubble.paddingY,
                    }
                  : {}),
              maxWidth: props.discord
                ? "100%"
                : props.usesNativeWorkspaceColumns && Platform.OS === "ios" && !Platform.isPad
                  ? "85%"
                  : userBubbleMaxWidth,
              ...(hasReviewCommentContext
                ? {
                    width: isAgentMessage
                      ? Math.min(props.reviewCommentBubbleWidth, userBubbleMaxWidth)
                      : props.reviewCommentBubbleWidth,
                  }
                : hasWideBlock
                  ? {
                      width:
                        !props.discord &&
                        props.usesNativeWorkspaceColumns &&
                        Platform.OS === "ios" &&
                        !Platform.isPad
                          ? "85%"
                          : userBubbleMaxWidth,
                    }
                  : null),
            }}
          >
            {entry.pendingMessage?.attachments.map((attachment) =>
              attachment.type === "image" && attachment.uploadedAttachmentId ? (
                <MessageAttachmentImage
                  key={attachment.id}
                  environmentId={props.environmentId}
                  attachmentId={attachment.uploadedAttachmentId}
                  name={attachment.name}
                  mimeType={attachment.mimeType}
                  {...(attachment.originalUploaded && attachment.original
                    ? { original: attachment.original, sentSize: attachment.sentSize }
                    : {})}
                  className="h-[140px] w-[180px] rounded-[14px]"
                  onPressPreview={props.onPressPreview}
                />
              ) : attachment.type === "image" ? (
                <Pressable
                  key={attachment.id}
                  accessibilityRole="imagebutton"
                  accessibilityLabel={`Open ${attachment.name}`}
                  onPress={() =>
                    props.onPressPreview({
                      kind: "image",
                      name: attachment.name,
                      uri: attachment.dataUrl ?? attachment.previewUri,
                      gallery: composerImageGallery(entry.pendingMessage?.attachments ?? []),
                    })
                  }
                >
                  <Image
                    source={{ uri: attachment.previewUri }}
                    style={{ width: 180, height: 140, borderRadius: 14 }}
                  />
                </Pressable>
              ) : (
                <MessageAttachmentUnknown key={attachment.id} name={attachment.name} />
              ),
            )}
            {/* An empty container still takes a gap, which pads every attachment-free bubble. */}
            {visibleAttachments.length > 0 ? (
              <View className={attachmentImageTile ? "flex-row flex-wrap gap-2" : "gap-2"}>
                {visibleAttachments.map((attachment) => {
                  return isImageAttachment(attachment) ? (
                    <MessageAttachmentImage
                      key={attachment.id}
                      environmentId={props.environmentId}
                      attachmentId={attachment.id}
                      name={attachment.name}
                      mimeType={attachment.mimeType}
                      {...(attachment.type === "image" && attachment.original
                        ? { original: attachment.original, sentSize: attachment.sentSize }
                        : {})}
                      className={
                        attachmentImageTile
                          ? "rounded-[12px] bg-user-bubble-foreground/15"
                          : "aspect-[1.3] w-full rounded-[14px] bg-user-bubble-foreground/15"
                      }
                      {...(attachmentImageTile ? { size: attachmentImageTile } : {})}
                      onPressPreview={props.onPressPreview}
                    />
                  ) : isFileAttachment(attachment) ? (
                    <MessageAttachmentFile
                      key={attachment.id}
                      environmentId={props.environmentId}
                      attachment={attachment}
                      onPressPreview={props.onPressPreview}
                      onPressVideo={props.onPressVideo}
                    />
                  ) : (
                    <MessageAttachmentUnknown key={attachment.id} name={attachment.name} />
                  );
                })}
              </View>
            ) : null}
            {presentation.text.trim().length > 0 ? (
              <MarkdownImageAvailableWidthContext
                value={
                  userBubbleMaxWidth -
                  (props.harnessView?.userBubble.paddingX ?? USER_BUBBLE_HORIZONTAL_PADDING) * 2
                }
              >
                <UserMessageContent
                  text={renderedText}
                  environmentId={props.environmentId}
                  context={message.context}
                  markdownStyles={styles}
                  reviewCommentColors={props.reviewCommentColors}
                  skills={props.skills}
                  linkHandlers={props.markdownLinkHandlers}
                  renderImage={props.renderMarkdownImage}
                />
              </MarkdownImageAvailableWidthContext>
            ) : null}
          </UserMessageBubble>
          <View
            className={
              props.discord
                ? "mt-0.5 flex-row items-center gap-1"
                : "mt-1 flex-row items-center justify-end gap-1 pr-0.5"
            }
          >
            {intentBadge ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={intentBadge.accessibilityLabel}
                accessibilityHint="Explains this message's badge"
                hitSlop={8}
                onPress={() => Alert.alert("Message history", intentBadge.explanation)}
                className={cn(
                  "rounded-full border px-1.5 py-0.5",
                  intentBadge.tone === "queued"
                    ? "border-adaptive-amber-500-a25-400-a25 bg-adaptive-amber-500-a10-400-a10"
                    : "border-adaptive-sky-500-a25-400-a25 bg-adaptive-sky-500-a10-400-a10",
                )}
              >
                <Text
                  className={cn(
                    "font-t3-medium text-2xs tracking-wide",
                    intentBadge.tone === "queued"
                      ? "text-adaptive-amber-700-300"
                      : "text-adaptive-sky-700-300",
                  )}
                >
                  {intentBadge.label}
                </Text>
              </Pressable>
            ) : null}
            <Text className="font-t3-medium text-xs tabular-nums text-foreground-secondary">
              {entry.serverQueued
                ? "Queued"
                : entry.pendingMessage && !entry.acknowledged
                  ? "Pending"
                  : props.discord
                    ? null
                    : timestampLabel}
            </Text>
            {props.onEditPendingMessage !== null &&
            entry.pendingMessage &&
            !entry.acknowledged &&
            !entry.pendingMessage.creation &&
            entry.pendingMessage.messageId !== props.dispatchingMessageId ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Edit pending message"
                hitSlop={8}
                className="size-7 items-center justify-center"
                onPress={() => {
                  if (entry.pendingMessage && props.onEditPendingMessage) {
                    props.onEditPendingMessage(entry.pendingMessage);
                  }
                }}
              >
                <SymbolView name="pencil" size={14} tintColor={iconSubtleColor} />
              </Pressable>
            ) : null}
            <MessageInlineActionButton tintColor={iconSubtleColor} />
            {presentation.text.trim().length > 0 ? (
              <MessageCopyButton
                text={presentation.text}
                promptLink
                onQuote={props.onQuoteMessage}
                onCopy={
                  message.context
                    ? () =>
                        writeComposerContextClipboard(presentation.text, {
                          version: 1,
                          source: { environmentId: props.environmentId, messageId: message.id },
                          records: message.context!.records,
                        })
                    : undefined
                }
                tintColor={iconSubtleColor}
              />
            ) : null}
          </View>
          {props.steerWait?.messageId === message.id ? (
            <SteerWaitLine wait={props.steerWait} onSendNow={props.onSendSteerNow} />
          ) : null}
        </Animated.View>
      );
      return isAgentMessage ? (
        <AgentMessageRow
          key={entry.id}
          anchorKey={entry.id}
          environmentId={props.environmentId}
          senderThreadId={message.senderThreadId}
          text={renderedText}
          inputIntent={message.inputIntent}
          status={message.projectedItem?.item.status}
          timestampLabel={timestampLabel}
          rowSizing={props.workRowSizing}
          iconSubtleColor={iconSubtleColor}
          onToggle={props.onToggleAgentMessage}
          onDisclosureLayout={props.onDisclosureLayout}
        >
          {bubble}
        </AgentMessageRow>
      ) : (
        bubble
      );
    }

    // Skip empty assistant messages (no text, no attachments) — they would
    // render as an orphaned timestamp and break adjacent activity-group merging.
    if (renderedText.trim().length === 0 && attachments.length === 0) {
      return null;
    }

    // Assistant messages hit the same Android unclamped-pass bug as user
    // bubbles: wide markdown blocks cause children to be positioned at
    // intrinsic width before the container is clamped, overlapping the
    // timestamp/copy button row. Pinning the width removes that pass.
    const enterAnimated = isFreshTimestamp(message.createdAt);
    const assistantImageAttachments = attachments.filter(isImageAttachment);
    return (
      <Animated.View
        className={cn(
          props.discord
            ? "px-0"
            : showAssistantMeta && !(message.runId && props.failedRunIds.has(message.runId))
              ? "mb-5 px-1"
              : "mb-1 px-1",
          hasWideBlock && "w-full",
        )}
        {...(enterAnimated ? { entering: FadeIn.duration(220) } : {})}
      >
        {renderedText.trim().length > 0 ? (
          <MarkdownImageAvailableWidthContext value={props.markdownContentWidth}>
            <CasualAssistantMessage
              environmentId={props.environmentId}
              threadId={props.threadId}
              messageId={message.id}
              original={message.text}
              streaming={Boolean(message.streaming)}
              discord={props.discord}
              active={props.casualVoice}
              runId={message.runId ?? null}
              role={showAssistantMeta ? "final" : "update"}
              agent={props.agentLabel}
            >
              {(text, displayOnly) => (
                <AssistantMarkdownContent
                  displayOnly={displayOnly}
                  markdown={renderAssistantCitationsAsText(text)}
                  isStreaming={message.streaming}
                  environmentId={props.environmentId}
                  markdownStyles={styles}
                  linkHandlers={props.markdownLinkHandlers}
                  onUseArtifactTemplate={displayOnly ? undefined : props.onUseArtifactTemplate}
                  renderImage={props.renderMarkdownImage}
                  renderImageGroup={props.renderMarkdownImageGroup}
                  assetScope={message.id}
                  skills={props.skills}
                />
              )}
            </CasualAssistantMessage>
          </MarkdownImageAvailableWidthContext>
        ) : null}
        {/* A link still being written would look up half an address. */}
        {message.streaming ? null : (
          <MarkdownImageAvailableWidthContext value={props.markdownContentWidth}>
            <XPostCards
              text={message.text}
              environmentId={props.environmentId}
              onOpen={props.markdownLinkHandlers.onLinkPress}
            />
          </MarkdownImageAvailableWidthContext>
        )}
        {assistantImageAttachments.length > 1 ? (
          <MessageAttachmentImageStrip
            environmentId={props.environmentId}
            attachments={assistantImageAttachments}
            onPressPreview={props.onPressPreview}
          />
        ) : null}
        {attachments.map((attachment) => {
          return isImageAttachment(attachment) ? (
            assistantImageAttachments.length > 1 ? null : (
              <MessageAttachmentImage
                key={attachment.id}
                environmentId={props.environmentId}
                attachmentId={attachment.id}
                name={attachment.name}
                mimeType={attachment.mimeType}
                {...(attachment.type === "image" && attachment.original
                  ? { original: attachment.original, sentSize: attachment.sentSize }
                  : {})}
                className="mt-1.5 aspect-[1.3] w-full rounded-[18px] bg-subtle-strong"
                onPressPreview={props.onPressPreview}
              />
            )
          ) : isFileAttachment(attachment) ? (
            <MessageAttachmentFile
              key={attachment.id}
              environmentId={props.environmentId}
              attachment={attachment}
              onPressPreview={props.onPressPreview}
              onPressVideo={props.onPressVideo}
            />
          ) : (
            <MessageAttachmentUnknown key={attachment.id} name={attachment.name} />
          );
        })}
        {showAssistantMeta ? (
          <View className="mt-1 flex-row items-center gap-1">
            <MessageCopyButton
              text={renderedText}
              onQuote={props.onQuoteMessage}
              tintColor={iconSubtleColor}
            />
            {message.projectedItem ? (
              <AssistantForkButton
                environmentId={props.environmentId}
                iconColor={iconSubtleColor}
                projectedItem={message.projectedItem}
                sourceTitle={props.threadTitle}
              />
            ) : null}
            {message.projectedItem ? (
              <AssistantPinButton
                environmentId={props.environmentId}
                threadId={props.threadId}
                messageId={message.id}
                text={renderedText}
                iconColor={iconSubtleColor}
              />
            ) : null}
            <Text className="font-t3-medium text-xs tabular-nums text-foreground-secondary">
              {props.discord ? null : timestampLabel}
            </Text>
          </View>
        ) : null}
      </Animated.View>
    );
  }

  return (
    <ThreadWorkLog
      // Fixed native rows need fresh measurement after a text-size change.
      // Anchors/details live in ThreadFeed and survive this group-only remount.
      key={`${entry.id}:${props.workRowSizing.textSizeKey}`}
      activities={entry.activities}
      continuesWorkLog={entry.continuesWorkLog}
      environmentId={props.environmentId}
      anchorKey={entry.id}
      copiedRowId={props.copiedRowId}
      expandedRows={props.expandedWorkRows}
      rowSizing={props.workRowSizing}
      scrollPositions={props.workGroupScrollPositions}
      iconSubtleColor={iconSubtleColor}
      edgeFadeColor={props.screenColor}
      themeAppearance={props.themeAppearance}
      onCopyRow={props.onCopyWorkRow}
      onToggleRow={props.onToggleWorkRow}
      renderImage={props.renderViewedImage}
      renderReasoning={props.renderReasoning}
      onPressPreview={props.onPressPreview}
    />
  );
}

type UserMessageContentProps = {
  readonly text: string;
  readonly environmentId: EnvironmentId;
  readonly context?: OrchestrationMessageContext;
  readonly markdownStyles: MarkdownStyleSet;
  readonly reviewCommentColors: ReviewCommentColors;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
  readonly linkHandlers: MarkdownLinkHandlers;
  readonly renderImage: MarkdownImageRenderer;
};

function UserMessageContent(props: UserMessageContentProps) {
  const [selected, setSelected] = useState<{ contextId: string; label: string } | null>(null);
  const navigation = useNavigation();
  const { selectedThread } = useThreadSelection();
  const liveText = useLiveThreadLinkLabels(props.text, props.environmentId);
  const text = replaceComposerContextReferences(liveText, (ref) => {
    const available = props.context?.records.some((record) => record.contextId === ref.contextId);
    return `[${ref.label}${available ? "" : " (unavailable)"}](t3-context://v1/${ref.kind}/${ref.contextId})`;
  });
  const onLinkPress = (href: string) => {
    const reference = parseComposerContextHref(href);
    if (!reference) return props.linkHandlers.onLinkPress?.(href);
    const record = props.context?.records.find(
      (record) => record.contextId === reference.contextId,
    );
    if (record?.kind === "mention" && "path" in record) {
      props.linkHandlers.onLinkPress?.(record.path);
      return;
    }
    if (record?.kind === "thread" && "threadId" in record) {
      navigation.navigate("Thread", {
        environmentId: String(record.environmentId),
        threadId: String(record.threadId),
      });
      return;
    }
    // Documents open in the file screen; pictures, video and PDF keep their native viewers.
    const document = composerDocumentAttachmentRecord(record);
    if (document) {
      navigation.navigate("ThreadAttachment", {
        environmentId: String(props.environmentId),
        ...(selectedThread ? { threadId: String(selectedThread.id) } : {}),
        attachmentId: document.attachmentId,
        name: document.name,
        mimeType: document.mimeType,
        sizeBytes: String(document.sizeBytes),
      });
      return;
    }
    setSelected({ contextId: reference.contextId, label: record?.label ?? "Context unavailable" });
  };
  return (
    <>
      <UserMessageMarkdownContent
        {...props}
        text={text}
        linkHandlers={{
          ...props.linkHandlers,
          onLinkPress,
          fileContextMenu: (href) => {
            const reference = parseComposerContextHref(href);
            if (!reference) return props.linkHandlers.fileContextMenu(href);
            const record = props.context?.records.find(
              (item) => item.contextId === reference.contextId,
            );
            return {
              title: record?.label ?? "Context unavailable",
              actions: [
                { id: "open-context", title: "Open context" },
                { id: "copy-context", title: "Copy context", disabled: !record },
              ],
            };
          },
          onFileContextMenuAction: (href, actionId) => {
            const reference = parseComposerContextHref(href);
            if (!reference) return props.linkHandlers.onFileContextMenuAction(href, actionId);
            if (actionId === "open-context") return onLinkPress(href);
            const record = props.context?.records.find(
              (item) => item.contextId === reference.contextId,
            );
            if (actionId === "copy-context" && record) {
              void writeComposerContextClipboard(
                formatComposerContextReference({
                  ...reference,
                  label: record.label,
                }),
                {
                  version: 1,
                  source: { environmentId: props.environmentId },
                  records: [record],
                },
              )
                .then(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success))
                .catch(() => {
                  Alert.alert("Could not copy context", "Try copying this context again.");
                });
            }
          },
          linkCustomization: (href) => {
            const presentation = enrichedContextLinkPresentation(href, props.context?.records);
            return presentation
              ? { color: presentation.color, icon: markdownFileIconSource(presentation.icon) }
              : props.linkHandlers.linkCustomization?.(href);
          },
        }}
      />
      <XPostCards
        text={props.text}
        environmentId={props.environmentId}
        onOpen={props.linkHandlers.onLinkPress}
      />
      {selected ? (
        <ComposerContextSheet
          label={selected.label}
          environmentId={props.environmentId}
          records={props.context?.records}
          record={props.context?.records.find((record) => record.contextId === selected.contextId)}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </>
  );
}

function UserMessageMarkdownContent(props: UserMessageContentProps) {
  const models = useModelMentions(props.environmentId, props.text);
  const text = props.text;
  const segments = parseReviewCommentMessageSegments(text);
  const hasReviewComment = segments.some((segment) => segment.kind === "review-comment");
  const contextClipboardFragment = props.context
    ? (encodeComposerContextFragment({
        version: 1,
        source: { environmentId: props.environmentId },
        records: props.context.records,
      }) ?? undefined)
    : undefined;
  if (!hasReviewComment) {
    return (
      <SelectableMarkdownText
        markdown={text}
        contextClipboardFragment={contextClipboardFragment}
        skills={props.skills}
        models={models}
        textStyle={props.markdownStyles.nativeTextStyle}
        preserveSoftBreaks
        {...props.linkHandlers}
        renderImage={props.renderImage}
      />
    );
  }

  return (
    <View className="w-full gap-2">
      {segments.map((segment) => {
        if (segment.kind === "review-comment") {
          return (
            <ReviewCommentCard
              key={segment.comment.id}
              comment={segment.comment}
              colors={props.reviewCommentColors}
            />
          );
        }

        const text = segment.text.trim();
        if (text.length === 0) {
          return null;
        }

        return (
          <SelectableMarkdownText
            key={segment.id}
            markdown={text}
            contextClipboardFragment={contextClipboardFragment}
            skills={props.skills}
            models={models}
            textStyle={props.markdownStyles.nativeTextStyle}
            preserveSoftBreaks
            {...props.linkHandlers}
            renderImage={props.renderImage}
          />
        );
      })}
    </View>
  );
}

function ThreadFeedPlaceholder(props: {
  readonly bottomInset: number;
  readonly detail: string;
  readonly horizontalPadding: number;
  readonly title: string;
  readonly topInset: number;
}) {
  return (
    <View
      style={{
        flex: 1,
        flexGrow: 1,
        alignItems: "center",
        justifyContent: "center",
        paddingTop: props.topInset,
        paddingBottom: props.bottomInset,
        paddingHorizontal: props.horizontalPadding + 24,
      }}
    >
      <View className="max-w-[320px] items-center gap-2">
        <Text className="text-center font-t3-bold text-lg text-foreground">{props.title}</Text>
        <Text className="text-center text-sm leading-normal text-foreground-secondary">
          {props.detail}
        </Text>
      </View>
    </View>
  );
}

function DiscordFeedRow(props: {
  readonly children: ReactNode;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly discord: boolean;
  readonly casualVoice: boolean;
  readonly entry: ThreadFeedEntry;
  readonly agentLabel: string;
  readonly agentDriver?: string | null;
  readonly avatar?: ReturnType<typeof discordAvatarIdentity> | undefined;
  readonly grouped: boolean;
}) {
  if (!props.discord) {
    if (
      props.casualVoice &&
      (props.entry.type === "activity-group" || props.entry.type === "work-toggle")
    ) {
      return (
        <>
          <CasualWorkStatus
            environmentId={props.environmentId}
            threadId={props.threadId}
            runId={props.entry.runId ?? null}
            active
          />
          {props.children}
        </>
      );
    }
    return props.children;
  }
  if (props.entry.type === "message")
    return (
      <DiscordMessage
        author={
          props.entry.message.role === "assistant"
            ? props.agentLabel
            : props.entry.message.senderThreadId
              ? "Agent"
              : "You"
        }
        assistant={
          props.entry.message.role === "assistant" || Boolean(props.entry.message.senderThreadId)
        }
        driver={props.agentDriver}
        avatar={props.avatar}
        timestamp={props.entry.message.createdAt}
        grouped={props.grouped && props.entry.message.role !== "assistant"}
      >
        {props.children}
      </DiscordMessage>
    );
  if (props.entry.type === "activity-group" || props.entry.type === "work-toggle")
    return (
      <View className="my-1 ml-[52px] rounded border-l-[3px] border-primary bg-card px-2 py-1">
        <CasualWorkStatus
          environmentId={props.environmentId}
          threadId={props.threadId}
          runId={props.entry.runId ?? null}
          active={props.casualVoice}
        />
        {props.children}
      </View>
    );
  return props.children;
}

function threadFeedKeyExtractor(entry: PendingThreadFeedEntry) {
  return entry.id;
}

function threadFeedGetItemType(entry: PendingThreadFeedEntry) {
  return entry.type === "message"
    ? entry.message.questionAnswer || entry.message.id.startsWith("async-answer:")
      ? "message:answer"
      : resolveUserMessagePresentation(entry.message).attribution === "agent"
        ? "message:agent"
        : `message:${entry.message.role}`
    : entry.type === "work-toggle" && workGroupImageSources(entry.activities).length > 0
      ? "work-toggle:images"
      : entry.type;
}

type ThreadFeedSharedRowContextValue = Omit<
  Parameters<typeof renderFeedEntry>[1],
  | "copiedRowId"
  | "expandedWorkRows"
  | "dispatchingMessageId"
  | "steerWait"
  | "unsettledTurnId"
  | "terminalAssistantMessageIds"
  | "failedRunIds"
  | "messageRunActive"
> & {
  readonly agentDriver: ThreadFeedProps["agentDriver"];
};

const EMPTY_EXPANDED_WORK_ROWS: Record<string, boolean> = {};
const EMPTY_STRING_SET: ReadonlySet<string> = new Set();
const EMPTY_RUN_ID_SET: ReadonlySet<RunId> = new Set();

const ThreadFeedSharedRowContext = createContext<ThreadFeedSharedRowContextValue | null>(null);
const ThreadFeedRowStoreContext = createContext<ThreadFeedRowStore | null>(null);

const ThreadFeedRow = memo(function ThreadFeedRow(props: {
  readonly item: PendingThreadFeedEntry;
}) {
  const shared = useContext(ThreadFeedSharedRowContext);
  const rowStore = useContext(ThreadFeedRowStoreContext);
  if (!shared || !rowStore) return null;
  return <ThreadFeedRowContent item={props.item} shared={shared} rowStore={rowStore} />;
});

const ThreadFeedRowContent = memo(function ThreadFeedRowContent(props: {
  readonly item: PendingThreadFeedEntry;
  readonly shared: ThreadFeedSharedRowContextValue;
  readonly rowStore: ThreadFeedRowStore;
}) {
  const { item, shared, rowStore } = props;
  const slice = useThreadFeedRowVolatileSlice(rowStore, item);
  const snapshot = rowStore.getSnapshot();
  const decoration =
    slice.decorationDay !== null || slice.decorationIsNew || slice.decorationGrouped
      ? {
          day: slice.decorationDay,
          isNew: slice.decorationIsNew,
          grouped: slice.decorationGrouped,
        }
      : undefined;
  const message = item.type === "message" ? item.message : null;
  const content = renderFeedEntry(
    { item, index: 0 },
    {
      ...shared,
      copiedRowId: slice.copiedRowId,
      expandedWorkRows:
        item.type === "activity-group" ? snapshot.expandedWorkRows : EMPTY_EXPANDED_WORK_ROWS,
      dispatchingMessageId:
        slice.isDispatching && item.type === "message" && item.pendingMessage
          ? item.pendingMessage.messageId
          : null,
      steerWait: slice.steerWait,
      unsettledTurnId: slice.isUnsettledTurn
        ? item.type === "message"
          ? item.message.runId
          : item.type === "activity-group"
            ? item.runId
            : null
        : null,
      terminalAssistantMessageIds: slice.isTerminalAssistant
        ? snapshot.terminalAssistantMessageIds
        : EMPTY_STRING_SET,
      failedRunIds: slice.isFailedRun ? snapshot.failedRunIds : EMPTY_RUN_ID_SET,
      messageRunActive: slice.messageRunActive,
    },
  );

  return (
    <Animated.View
      key={item.id}
      entering={
        snapshot.disclosureToggleSettling ? THREAD_FEED_DISCLOSURE_ENTER_TRANSITION : undefined
      }
    >
      <ThreadMediaVisibility>
        <TimelineDividers decoration={decoration} />
        <FeedEntryModelSwitchDivider
          entry={item}
          environmentId={shared.environmentId}
          iconColor={shared.iconSubtleColor}
        />
        <DiscordFeedRow
          environmentId={shared.environmentId}
          threadId={shared.threadId}
          discord={shared.discord}
          casualVoice={shared.casualVoice}
          entry={item}
          agentLabel={shared.agentLabel}
          agentDriver={shared.agentDriver}
          avatar={slice.avatar}
          grouped={slice.decorationGrouped}
        >
          {message?.projectedItem ? (
            <MessageWorkflowProvider
              message={message}
              projectedItem={message.projectedItem}
              environmentId={shared.environmentId}
              threadId={shared.threadId}
              threadTitle={shared.threadTitle}
              draftKey={shared.draftKey}
              canOperate={shared.canOperateMessage}
              supportsRollback={shared.supportsRollback}
              active={slice.messageRunActive}
              rewindInProgress={shared.rewindInProgress}
              onRewindingChange={shared.onRewindingChange}
            >
              {content}
            </MessageWorkflowProvider>
          ) : (
            content
          )}
        </DiscordFeedRow>
        {slice.worktreeSetup ? (
          <WorktreeSetupCard key={shared.threadId} {...slice.worktreeSetup} />
        ) : slice.setupWorkingStartedAt ? (
          <WorktreeWorkingHeader startedAt={slice.setupWorkingStartedAt} />
        ) : null}
      </ThreadMediaVisibility>
    </Animated.View>
  );
});

export const ThreadFeed = memo(function ThreadFeed(props: ThreadFeedProps) {
  const queueWorkflow = useAtomValue(
    environmentThreadDetails.queueWorkflowAtom({
      environmentId: props.environmentId,
      threadId: props.threadId,
    }),
  );
  const [uiMode] = useUiMode();
  const discord = uiMode === "discord";
  const casualVoice = useCasualVoiceActive();
  const usesNativeWorkspaceColumns = useNativeWorkspaceColumnsSupported();
  const openPullRequest = useOpenPullRequest();
  const navigation = useNavigation();
  const { themeAppearance, harnessThemePreset } = useAppearancePreferences();
  const harnessView = harnessThemePreset?.view ?? null;
  const copyFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disclosureSettleFrameRef = useRef<number | null>(null);
  const disclosureSettleSecondFrameRef = useRef<number | null>(null);
  const disclosureAnchorKeyRef = useRef<string | null>(null);
  const previousLatestTurnRef = useRef(props.latestRun);
  const userScrollSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const headerMaterialVisibleRef = useRef(false);
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const { appearance } = useAppearancePreferences();
  const workRowSizing = useMemo(
    () => deriveThreadWorkLogSizing({ baseFontSize: appearance.baseFontSize, fontScale }),
    [appearance.baseFontSize, fontScale],
  );
  const previousTextSize = useRef({ key: workRowSizing.textSizeKey, discord });
  useLayoutEffect(() => {
    if (
      previousTextSize.current.key === workRowSizing.textSizeKey &&
      previousTextSize.current.discord === discord
    ) {
      return;
    }
    previousTextSize.current = { key: workRowSizing.textSizeKey, discord };
    // Text-size changes invalidate the outer list's fixed-height cache too.
    // This never runs for scrolling, streamed output, or disclosure toggles.
    props.listRef.current?.clearCaches({ mode: "sizes" });
  }, [workRowSizing.textSizeKey, props.listRef, discord]);
  const [viewportWidth, setViewportWidth] = useState(() =>
    props.layoutVariant === "split" ? 0 : windowWidth,
  );
  const [viewportHeight, setViewportHeight] = useState(0);
  const isPhone = Platform.OS === "ios" && !Platform.isPad;
  const waitingForViewport = isPhone && (viewportHeight === 0 || viewportWidth === 0);
  const [loadedListKey, setLoadedListKey] = useState<string | null>(null);
  const [disclosureToggleSettling, setDisclosureToggleSettling] = useState(false);
  // Live-follow latch (#5566). LegendList's maintainScrollAtEnd alone re-pins
  // the feed whenever the viewport drifts back inside its geometric threshold,
  // which yanked users off history they were reading every time a stream chunk
  // grew a row. Follow breaks when the user scrolls up and away, and re-arms
  // only when the list actually returns to the end (or on send / thread switch).
  const [endFollowEnabled, setEndFollowEnabled] = useState(true);
  const endFollowEnabledRef = useRef(true);
  // A "user scroll session" spans from drag start through the end of its
  // momentum; scroll events only break follow inside that session, so MVCP
  // compensations and programmatic scrolls never strand a follower.
  const userScrollSessionRef = useRef(false);
  const setEndFollow = useCallback(
    (enabled: boolean) => {
      if (endFollowEnabledRef.current === enabled) {
        return;
      }
      endFollowEnabledRef.current = enabled;
      setEndFollowEnabled(enabled);
      props.onEndFollowEnabledChange?.(enabled);
    },
    [props.onEndFollowEnabledChange],
  );
  const transitionEndFollow = useCallback(
    (event: ThreadFeedLiveFollowEvent) => {
      setEndFollow(resolveThreadFeedLiveFollow(endFollowEnabledRef.current, event));
    },
    [setEndFollow],
  );
  // From opening a chat until the reader drags, sends, or toggles a
  // disclosure, late feed data and row measurements pull it to the end.
  const openingPinActiveRef = useRef(false);
  const openingPinFrameRef = useRef<number | null>(null);
  const endOpeningPin = useCallback(() => {
    openingPinActiveRef.current = false;
    if (openingPinFrameRef.current !== null) {
      cancelAnimationFrame(openingPinFrameRef.current);
      openingPinFrameRef.current = null;
    }
  }, []);
  const pinOpeningToEnd = useCallback(() => {
    if (!openingPinActiveRef.current || openingPinFrameRef.current !== null) {
      return;
    }
    // Wait a frame so LegendList has applied the data or size change.
    openingPinFrameRef.current = requestAnimationFrame(() => {
      openingPinFrameRef.current = null;
      const list = props.listRef.current;
      const listState = list?.getState();
      if (
        openingPinActiveRef.current &&
        listState &&
        shouldPinThreadFeedOpeningToEnd({
          followEnabled: endFollowEnabledRef.current,
          userScrollSessionActive: userScrollSessionRef.current,
          isAtEnd: listState.isAtEnd,
          contentLength: listState.contentLength,
          scrollLength: listState.scrollLength,
        })
      ) {
        void list?.scrollToEnd({ animated: false });
      }
    });
  }, [props.listRef]);
  useEffect(() => endOpeningPin, [endOpeningPin]);
  const [interactionState, setInteractionState] = useState<{
    readonly copiedRowId: string | null;
    readonly expandedWorkGroups: Record<string, boolean>;
    readonly expandedWorkRows: Record<string, boolean>;
    readonly expandedTurnIds: ReadonlySet<RunId>;
  }>({
    copiedRowId: null,
    expandedWorkGroups: {},
    expandedWorkRows: {},
    expandedTurnIds: new Set(),
  });
  const { copiedRowId, expandedWorkGroups, expandedWorkRows, expandedTurnIds } = interactionState;
  const [expandedFile, setExpandedFile] = useState<FilePreviewSource | null>(null);
  // Link presses read the latest thread gallery without re-creating every link handler.
  const threadGalleryRef = useRef<ReturnType<typeof threadImageGallery>>([]);
  const [expandedVideo, setExpandedVideo] = useState<VideoPreviewSource | null>(null);
  const fileShareSourceIdentifier = useId();
  const shareFileChip = useFileChipShare(
    props.environmentId,
    props.threadId,
    fileShareSourceIdentifier,
  );
  useEffect(() => {
    setExpandedVideo(null);
    setExpandedFile(null);
  }, [props.environmentId, props.threadId, props.contentPresentation.kind]);
  const horizontalPadding = props.layoutVariant === "split" ? 20 : 16;
  const contentLeftInset = props.contentSideInsets?.left ?? 0;
  const contentRightInset = props.contentSideInsets?.right ?? 0;
  const usableViewportWidth = Math.max(0, viewportWidth - contentLeftInset - contentRightInset);
  const contentHorizontalPadding = deriveCenteredContentHorizontalPadding({
    viewportWidth: usableViewportWidth,
    maxContentWidth: props.contentMaxWidth ?? null,
    minimumPadding: horizontalPadding,
  });
  const contentWidth = Math.max(0, usableViewportWidth - contentHorizontalPadding * 2);
  const userBubbleMaxWidth = discord ? Math.max(0, contentWidth - 52) : contentWidth * 0.85;
  const markdownContentWidth = Math.max(
    0,
    contentWidth - (discord ? 52 : ASSISTANT_ROW_HORIZONTAL_PADDING * 2),
  );
  const reviewCommentBubbleWidth = Math.min(Math.max(280, contentWidth * 0.85), contentWidth);
  const insets = useSafeAreaInsets();
  const topContentInset = props.contentTopInset ?? insets.top + IOS_NAV_BAR_HEIGHT;
  const bottomContentInset = props.contentBottomInset ?? 18;
  const usesNativeAutomaticInsets =
    props.usesAutomaticContentInsets === true && Platform.OS === "ios";
  const initialContentInset = deriveThreadFeedInitialContentInset({
    platform: Platform.OS,
    usesNativeAutomaticInsets,
    bottomContentInset,
  });
  // With automatic insets the header inset lives in UIKit's adjustedContentInset,
  // which LegendList's JS anchoring math cannot see — it measures the anchored
  // end space from the scroll view's frame top. Fold the header height back into
  // the anchor offset or a just-sent message anchors underneath the header and
  // the oversized end space keeps maintainScrollAtEnd snapping away from earlier
  // messages. Read the context directly (useHeaderHeight throws outside a
  // header-providing screen) and fall back to the standard iOS bar height.
  const navigationHeaderHeight = useContext(HeaderHeightContext);
  const anchorTopInset = usesNativeAutomaticInsets
    ? (navigationHeaderHeight ?? insets.top + IOS_NAV_BAR_HEIGHT)
    : topContentInset;

  const theme = useUniwindTheme();
  const iconSubtleColor = theme["--color-icon-subtle"];
  const screenColor = theme["--color-screen"];
  const userBubbleColor = theme["--color-user-bubble"];
  const onMarkdownLinkPress = useCallback(
    (pressedHref: string, imageEmbed = false) => {
      const href = resolveHomeRelativeHref(pressedHref, props.workspaceRoot);
      // A thread link names a thread in this feed's environment.
      const linkedThreadId = parseThreadLinkHref(href);
      if (linkedThreadId) {
        navigation.navigate("Thread", {
          environmentId: String(props.environmentId),
          threadId: String(linkedThreadId),
        });
        return;
      }
      const media = resolveMarkdownMediaPreview(href, {
        environmentId: props.environmentId,
        threadId: props.threadId,
        workspaceRoot: props.workspaceRoot,
        imageEmbed,
      });
      if (media) {
        void Haptics.selectionAsync();
        if (media.kind === "video") {
          setExpandedVideo((current) => current ?? media.source);
        } else {
          // Natively drawn images page through the same thread gallery as the rest.
          const gallery = media.kind === "image" ? threadGalleryRef.current : undefined;
          setExpandedFile(
            (current) => current ?? (gallery ? { ...media.source, gallery } : media.source),
          );
        }
        return;
      }

      const presentation = resolveMarkdownLinkPresentation(href);
      if (presentation.kind === "file") {
        const relativePath = resolveWorkspaceRelativeFilePath(
          props.workspaceRoot,
          presentation.path,
        );
        if (relativePath) {
          void Haptics.selectionAsync();
          navigation.navigate("ThreadFile", {
            environmentId: String(props.environmentId),
            threadId: String(props.threadId),
            path: fileRoutePathSegments(relativePath),
            ...(presentation.line ? { line: String(presentation.line) } : {}),
          });
          return;
        }
      }

      // A host file outside the workspace, such as a report an agent wrote to
      // a temp directory, opens read-only in the file screen.
      if (presentation.kind === "file" && isAbsolutePath(presentation.path)) {
        void Haptics.selectionAsync();
        navigation.navigate("ThreadFile", {
          environmentId: String(props.environmentId),
          threadId: String(props.threadId),
          path: fileRoutePathSegments(presentation.path),
          ...(presentation.line ? { line: String(presentation.line) } : {}),
        });
        return;
      }

      if (presentation.kind !== "file" && presentation.href) {
        if (/^https?:\/\//i.test(presentation.href) && isPdfFile({ name: presentation.href })) {
          setExpandedFile(
            (current) => current ?? { kind: "pdf", uri: presentation.href!, name: "Document.pdf" },
          );
          return;
        }
        void openPullRequest(presentation.href);
      }
    },
    [props.environmentId, props.threadId, props.workspaceRoot, navigation, openPullRequest],
  );
  const resolveImageSource = useMarkdownImageSource({
    environmentId: props.environmentId,
    threadId: props.threadId,
    workspaceRoot: props.workspaceRoot ?? null,
  });
  const markdownLinkHandlers = useMemo<MarkdownLinkHandlers>(
    () => ({
      onLinkPress: onMarkdownLinkPress,
      onImagePress: (href) => onMarkdownLinkPress(href, true),
      resolveImageSource,
      fileContextMenu: (href) => {
        const target = resolveFileChipTarget(href, props.workspaceRoot);
        return target ? fileChipMenu(target) : undefined;
      },
      onFileContextMenuAction: (href, actionId) => {
        const target = resolveFileChipTarget(href, props.workspaceRoot);
        if (!target) return;
        switch (actionId as FileChipAction) {
          case "copy-full-path":
            if (target.fullPath) copyTextWithHaptic(target.fullPath);
            return;
          case "copy-relative-path":
            if (target.relativePath) copyTextWithHaptic(target.relativePath);
            return;
          case "open-file":
            onMarkdownLinkPress(href);
            return;
          case "save":
            shareFileChip(target);
            return;
        }
      },
    }),
    [onMarkdownLinkPress, props.workspaceRoot, shareFileChip, resolveImageSource],
  );
  const renderMarkdownImage = useCallback<ScopedMarkdownImageRenderer>(
    (image, scope) => {
      const media = resolveMarkdownMediaPreview(image.href, {
        environmentId: props.environmentId,
        threadId: props.threadId,
        workspaceRoot: props.workspaceRoot,
        imageEmbed: true,
        scope,
      });
      if (media?.kind === "video") {
        return (
          <ThreadMarkdownVideo
            key={image.href}
            source={{ ...media.source, name: image.alt ?? media.source.name }}
          />
        );
      }
      const imageSource = classifyMarkdownImageSource(image.href, props.workspaceRoot ?? null);
      if (imageSource._tag === "Direct") {
        return (
          <ThreadMarkdownImageView
            uri={normalizeNativeMarkdownUrl(imageSource.uri)}
            sourceKey={imageSource.uri}
            format={
              /\.svg(?:[?#]|$)/i.test(imageSource.uri) ||
              imageSource.uri.startsWith("data:image/svg+xml")
                ? "svg"
                : undefined
            }
            unavailable={false}
            alt={image.alt}
            actionsSource={media?.source.actionsSource}
            onPressPreview={(source) => setExpandedFile((current) => current ?? source)}
          />
        );
      }
      if (imageSource._tag === "Blocked") {
        return <ThreadMarkdownImageUnavailable alt={image.alt} />;
      }
      return (
        <ThreadMarkdownImage
          environmentId={props.environmentId}
          resource={{
            _tag: "media-file",
            threadId: props.threadId,
            path: imageSource.path,
            ...(scope ? { scope } : {}),
            ...(imageSource.relative ? { hostOnly: true as const } : {}),
          }}
          alt={image.alt}
          srcFragment={markdownImageSourceFragment(image.href)}
          actionsSource={media?.source.actionsSource}
          onPressPreview={(source) => setExpandedFile((current) => current ?? source)}
        />
      );
    },
    [props.environmentId, props.threadId, props.workspaceRoot],
  );
  const renderMarkdownImageGroup = useCallback(
    (images: ReadonlyArray<MarkdownImageReference>, scope?: string): ReactNode => {
      const context = {
        environmentId: props.environmentId,
        threadId: props.threadId,
        workspaceRoot: props.workspaceRoot,
        imageEmbed: true,
        scope,
      };
      const occurrences = new Map<string, number>();
      const entries = images.map((image) => {
        const occurrence = (occurrences.get(image.href) ?? 0) + 1;
        occurrences.set(image.href, occurrence);
        return {
          image,
          key: `${occurrence}:${image.href}`,
          media: resolveMarkdownMediaPreview(image.href, context),
        };
      });
      // One image, or a group holding a video or PDF, renders as full-size blocks.
      if (entries.length === 1 || entries.some(({ media }) => media && media.kind !== "image")) {
        return (
          <View className="gap-2">
            {entries.map(({ image, key }) => (
              <View key={key}>{renderMarkdownImage(image, scope)}</View>
            ))}
          </View>
        );
      }
      const items = entries.map(({ image, key, media: preview }): ThreadImageStripItem => {
        const name = image.alt ?? preview?.source.name ?? "Image";
        return preview?.kind === "image"
          ? { key, name, preview: preview.source, actionsSource: preview.source.actionsSource }
          : { key, name, unavailable: true };
      });
      return (
        <ThreadImageStrip
          items={items}
          height={MESSAGE_IMAGE_STRIP_HEIGHT}
          onPressPreview={(source) => setExpandedFile((current) => current ?? source)}
        />
      );
    },
    [props.environmentId, props.threadId, props.workspaceRoot, renderMarkdownImage],
  );
  const renderViewedImage = useCallback<MarkdownImageRenderer>(
    (image) => {
      const viewedImage = resolveViewedImageAsset(image.href, {
        threadId: props.threadId,
        workspaceRoot: props.workspaceRoot,
      });
      const media = viewedImage
        ? resolveMarkdownMediaPreview(image.href, {
            environmentId: props.environmentId,
            threadId: props.threadId,
            workspaceRoot: props.workspaceRoot,
            imageEmbed: true,
          })
        : null;
      const actionsSource = media?.source.actionsSource;
      return viewedImage ? (
        <ThreadMarkdownImage
          environmentId={props.environmentId}
          resource={viewedImage.resource}
          alt={viewedImage.alt}
          srcFragment={viewedImage.srcFragment}
          actionsSource={
            actionsSource && "resource" in actionsSource
              ? { ...actionsSource, resource: viewedImage.resource }
              : undefined
          }
          onPressPreview={(source) => setExpandedFile((current) => current ?? source)}
        />
      ) : null;
    },
    [props.environmentId, props.threadId, props.workspaceRoot],
  );
  const markdownStyles = useMarkdownStyles();
  // Expanded thoughts render like replies.
  const renderReasoning = useCallback(
    (text: string) =>
      discord ? null : (
        <AssistantMarkdownContent
          markdown={text}
          environmentId={props.environmentId}
          markdownStyles={markdownStyles.assistant}
          linkHandlers={markdownLinkHandlers}
          renderImage={renderMarkdownImage}
          renderImageGroup={renderMarkdownImageGroup}
          skills={props.skills}
        />
      ),
    [
      discord,
      markdownStyles.assistant,
      markdownLinkHandlers,
      renderMarkdownImage,
      renderMarkdownImageGroup,
      props.environmentId,
      props.skills,
    ],
  );
  const reviewCommentColors = useReviewCommentColors();
  const unsettledTurnId = threadFeedRunIsUnsettled(props.latestRun) ? props.latestRun.runId : null;
  const reportHeaderMaterialVisibility = useCallback(
    (visible: boolean) => {
      if (headerMaterialVisibleRef.current === visible) {
        return;
      }
      headerMaterialVisibleRef.current = visible;
      props.onHeaderMaterialVisibilityChange?.(visible);
    },
    [props.onHeaderMaterialVisibilityChange],
  );
  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      // anchorTopInset, not topContentInset: under automatic insets the list
      // rests at contentOffset.y = -headerHeight (the inset lives only in
      // UIKit's adjustedContentInset, so topContentInset is 0 here). Add the
      // header height back or the material toggles a full header too late.
      reportHeaderMaterialVisibility(event.nativeEvent.contentOffset.y + anchorTopInset > 6);
      // LegendList recomputes its inset-aware end distance before invoking
      // this handler, so getState() is current. Only the actual end re-arms
      // follow: its broader maintain-scroll threshold is large enough for a
      // streaming chunk to pull a user back before their upward drag escapes.
      // A live user-scroll session still wins even if the first scroll event
      // remains inside LegendList's at-end tolerance.
      const listState = props.listRef.current?.getState();
      if (listState) {
        transitionEndFollow({
          type: "scroll",
          isAtEnd: listState.isAtEnd,
          userScrollSessionActive: userScrollSessionRef.current,
        });
      }
    },
    [reportHeaderMaterialVisibility, anchorTopInset, props.listRef, transitionEndFollow],
  );
  const clearUserScrollSettle = useCallback(() => {
    if (userScrollSettleTimerRef.current !== null) {
      clearTimeout(userScrollSettleTimerRef.current);
      userScrollSettleTimerRef.current = null;
    }
  }, []);
  const handleScrollBeginDrag = useCallback(() => {
    clearUserScrollSettle();
    endOpeningPin();
    userScrollSessionRef.current = true;
    // Pause before the first scroll event. Otherwise a stream update can run
    // maintainScrollAtEnd between touch-down and the drag leaving its threshold.
    transitionEndFollow({ type: "user-scroll-begin" });
  }, [clearUserScrollSettle, endOpeningPin, transitionEndFollow]);
  const finishUserScroll = useCallback(
    (releaseIsAtEnd?: boolean) => {
      clearUserScrollSettle();
      const userScrollSessionActive = userScrollSessionRef.current;
      userScrollSessionRef.current = false;
      transitionEndFollow({
        type: "user-scroll-end",
        // With no momentum, preserve the finger-release position. Streaming
        // growth during the native momentum-detection window must not turn a
        // release at the live edge into an opt-out from follow.
        isAtEnd: releaseIsAtEnd ?? props.listRef.current?.getState().isAtEnd ?? false,
        userScrollSessionActive,
      });
    },
    [clearUserScrollSettle, props.listRef, transitionEndFollow],
  );
  // Finger-lift velocity is not a reliable momentum signal: a gentle fling
  // can report zero and still decelerate. Give native momentum a short window
  // to announce itself; if it does, onMomentumScrollBegin cancels this fallback
  // and the session survives until the settled momentum-end position. This
  // mirrors the native-event handoff used by the home thread list's scroll gate.
  const handleScrollEndDrag = useCallback(() => {
    clearUserScrollSettle();
    const releaseIsAtEnd = props.listRef.current?.getState().isAtEnd ?? false;
    userScrollSettleTimerRef.current = setTimeout(() => finishUserScroll(releaseIsAtEnd), 160);
  }, [clearUserScrollSettle, finishUserScroll, props.listRef]);
  const handleMomentumScrollBegin = useCallback(() => {
    if (userScrollSessionRef.current) {
      clearUserScrollSettle();
    }
  }, [clearUserScrollSettle]);
  const handleMomentumScrollEnd = useCallback(() => {
    finishUserScroll();
  }, [finishUserScroll]);

  useEffect(() => clearUserScrollSettle, [clearUserScrollSettle]);

  // Thread identity is env-scoped: two environments can hold the same
  // ThreadId, and keying resets (or the list mount) on the bare id would
  // carry stale scroll/follow state across an environment switch.
  const feedThreadKey = scopedThreadKey(props.environmentId, props.threadId);
  // Virtualized groups can unmount without losing the reader's place. This cache
  // belongs to this thread view only and never causes per-scroll React updates.
  const workGroupScrollPositions = useMemo(
    () => new Map<string, ThreadWorkGroupScrollPosition>(),
    [feedThreadKey],
  );
  // A thread switch opens pinned to the end; a send explicitly returns to the
  // live edge (ThreadDetailScreen scrolls the new message into place). Both
  // re-arm follow regardless of where the user had scrolled before.
  // Closing an image, file, sheet or another chat opened on top of this one
  // returns to where the reader was, like back navigation in the native apps.
  const coveredOnBlurRef = useRef(false);
  const feedNavigation = useNavigation();
  const feedRouteKey = useRoute().key;
  useEffect(
    () =>
      feedNavigation.addListener("blur", () => {
        const routes = feedNavigation.getState()?.routes ?? [];
        const ownIndex = routes.findIndex((route) => route.key === feedRouteKey);
        coveredOnBlurRef.current = ownIndex !== -1 && ownIndex < routes.length - 1;
      }),
    [feedNavigation, feedRouteKey],
  );
  useFocusEffect(
    useCallback(() => {
      if (coveredOnBlurRef.current) {
        coveredOnBlurRef.current = false;
        return;
      }
      clearUserScrollSettle();
      userScrollSessionRef.current = false;
      transitionEndFollow({ type: "reset" });
      openingPinActiveRef.current = true;
      // Navigation can retain this screen, including a scroll position from the
      // last visit. Reopen at the latest even when the thread key is unchanged.
      pinOpeningToEnd();
      return endOpeningPin;
    }, [clearUserScrollSettle, endOpeningPin, feedThreadKey, pinOpeningToEnd, transitionEndFollow]),
  );
  useEffect(() => {
    if (props.submittedMessageId !== null) {
      // The send anchors its message near the top; the opening pin would
      // pull it back down to the end.
      endOpeningPin();
      clearUserScrollSettle();
      userScrollSessionRef.current = false;
      transitionEndFollow({ type: "reset" });
    }
  }, [clearUserScrollSettle, endOpeningPin, props.submittedMessageId, transitionEndFollow]);

  const handleViewportLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const nextWidth = Math.round(event.nativeEvent.layout.width);
      const nextHeight = Math.round(event.nativeEvent.layout.height);
      if (isPhone && (nextWidth <= 0 || nextHeight <= 0)) return;
      setViewportWidth((current) => (Math.abs(current - nextWidth) > 1 ? nextWidth : current));
      setViewportHeight((current) => (Math.abs(current - nextHeight) > 1 ? nextHeight : current));
    },
    [isPhone],
  );

  useEffect(() => {
    reportHeaderMaterialVisibility(false);
  }, [feedThreadKey, reportHeaderMaterialVisibility]);

  const projectFeedPresentation = useMemo(() => createThreadFeedPresentationProjector(), []);
  const expandedWorkGroupIds = useMemo(
    () =>
      new Set(
        Object.entries(expandedWorkGroups)
          .filter(([, expanded]) => expanded)
          .map(([groupId]) => groupId),
      ),
    [expandedWorkGroups],
  );
  const appendPendingThreadMessages = useMemo(() => createPendingThreadMessagesProjector(), []);
  const filterDiscordThreadFeed = useMemo(
    () => createDiscordThreadFeedProjector<PendingThreadFeedEntry>(),
    [],
  );
  const stabilizePresentedFeed = useMemo(
    () => createStableThreadFeedProjector<PendingThreadFeedEntry>(),
    [],
  );
  const unfilteredPresentedFeed = useMemo(
    () =>
      appendPendingThreadMessages(
        projectFeedPresentation(
          props.feed,
          props.latestRun,
          expandedTurnIds,
          expandedWorkGroupIds,
          props.activeWorkStartedAt,
          props.runlessWorkActive ?? false,
        ),
        props.feed,
        props.queuedMessages,
        queueWorkflow?.queuedRuns,
        props.threadId,
      ),
    [
      projectFeedPresentation,
      appendPendingThreadMessages,
      props.queuedMessages,
      queueWorkflow?.queuedRuns,
      props.threadId,
      expandedTurnIds,
      expandedWorkGroupIds,
      props.activeWorkStartedAt,
      props.runlessWorkActive,
      props.feed,
      props.latestRun,
    ],
  );
  const presentedFeed = useMemo(
    () =>
      stabilizePresentedFeed(
        discord ? filterDiscordThreadFeed(unfilteredPresentedFeed) : unfilteredPresentedFeed,
      ),
    [discord, unfilteredPresentedFeed, filterDiscordThreadFeed, stabilizePresentedFeed],
  );
  const projectDecorations = useMemo(() => createTimelineDecorationsProjector(), []);
  const completedMediaJump = useRef<number | null>(null);
  useEffect(() => {
    const request = props.mediaJump;
    if (waitingForViewport || !request || completedMediaJump.current === request.sequence) return;
    const matches = (row: ThreadFeedEntry) =>
      row.type === "message"
        ? matchesTimelineJump(row.message.projectedItem, request.item)
        : row.type === "activity-group" || row.type === "work-toggle"
          ? row.activities.some((activity) =>
              matchesTimelineJump(activity.projectedItem, request.item),
            )
          : false;
    const index = presentedFeed.findIndex(matches);
    if (index < 0) {
      const original = props.feed.find(matches);
      const runId =
        original?.type === "message"
          ? original.message.runId
          : original?.type === "activity-group" || original?.type === "work-toggle"
            ? original.runId
            : null;
      if (runId && !expandedTurnIds.has(runId))
        setInteractionState((current) => ({
          ...current,
          expandedTurnIds: new Set(current.expandedTurnIds).add(runId),
        }));
      return;
    }
    const row = presentedFeed[index]!;
    if (row.type === "work-toggle" && !row.expanded) {
      setInteractionState((current) => ({
        ...current,
        expandedWorkGroups: { ...current.expandedWorkGroups, [row.groupId]: true },
      }));
      return;
    }
    const list = props.listRef.current;
    if (!list) return;
    completedMediaJump.current = request.sequence;
    endOpeningPin();
    setEndFollow(false);
    void list.scrollToIndex({ index, animated: true, viewOffset: 24 });
    props.onMediaJumpHandled?.(request.sequence);
  }, [
    waitingForViewport,
    props.mediaJump,
    props.onMediaJumpHandled,
    props.feed,
    props.listRef,
    presentedFeed,
    expandedTurnIds,
    endOpeningPin,
    setEndFollow,
  ]);
  const decorations = useMemo(
    () => projectDecorations(presentedFeed, props.visitedAtOpen),
    [projectDecorations, presentedFeed, props.visitedAtOpen],
  );
  // Every image the feed shows, so the viewer pages through the whole conversation.
  // The list keeps its identity while images are unchanged: streamed text must not
  // re-render every image that reads the gallery.
  const computedThreadGallery = useMemo(
    () =>
      threadImageGallery(presentedFeed, {
        environmentId: props.environmentId,
        threadId: props.threadId,
        workspaceRoot: props.workspaceRoot,
      }),
    [presentedFeed, props.environmentId, props.threadId, props.workspaceRoot],
  );
  const [threadGallery, setThreadGallery] = useState(computedThreadGallery);
  if (!sameFilePreviewItems(computedThreadGallery, threadGallery)) {
    setThreadGallery(computedThreadGallery);
  }
  useEffect(() => {
    threadGalleryRef.current = threadGallery;
  }, [threadGallery]);
  const feedSummary = useMemo(() => threadFeedSummary(props.feed), [props.feed]);
  const presentedFeedSummary = useMemo(() => threadFeedSummary(presentedFeed), [presentedFeed]);
  const setupAnchorIndex = presentedFeedSummary.firstUserIndex;
  // The empty↔filled key below remounts the list and resets its imperative
  // content-inset override. Seed the fresh instance synchronously with the
  // current overlay height before the scroll integration's next reaction;
  // on Android the declarative contentInset floor covers this same window.
  // The thinking row a running thread shows while its messages load is not
  // content: the list must still remount, and so open at the end, when they
  // arrive.
  const listMountKey = `${feedThreadKey}:${presentedFeedSummary.hasContent ? "filled" : "empty"}`;
  useLayoutEffect(() => {
    const bottom = props.contentInsetEndAdjustment.value;
    if (bottom > 0) {
      props.listRef.current?.reportContentInset({ bottom });
    }
  }, [listMountKey, waitingForViewport, props.contentInsetEndAdjustment, props.listRef]);

  const anchoredEndSpace = useMemo(
    () =>
      resolveChatListAnchoredEndSpace(
        presentedFeed,
        props.anchorMessageId,
        (entry) => (entry.type === "message" ? entry.id : null),
        { anchorOffset: anchorTopInset + CHAT_LIST_ANCHOR_OFFSET },
      ),
    [presentedFeed, props.anchorMessageId, anchorTopInset],
  );
  const failedRunIds = useMemo(
    () => threadFeedFailedRunIds(feedSummary, props.latestRun),
    [feedSummary, props.latestRun],
  );
  const terminalAssistantMessageIds = feedSummary.terminalAssistantMessageIds;
  useEffect(() => {
    const previous = previousLatestTurnRef.current;
    previousLatestTurnRef.current = props.latestRun;
    if (!props.latestRun || !previous) {
      return;
    }
    if (props.latestRun.runId === previous.runId) {
      if (previous.status === "running" && props.latestRun.status === "interrupted") {
        const interruptedTurnId = props.latestRun.runId;
        setInteractionState((current) => ({
          ...current,
          expandedTurnIds: new Set(current.expandedTurnIds).add(interruptedTurnId),
        }));
      }
      return;
    }
    setInteractionState((current) => {
      if (!current.expandedTurnIds.has(previous.runId)) {
        return current;
      }
      const next = new Set(current.expandedTurnIds);
      next.delete(previous.runId);
      return { ...current, expandedTurnIds: next };
    });
  }, [props.latestRun]);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimeoutRef.current) {
        clearTimeout(copyFeedbackTimeoutRef.current);
      }
      if (disclosureSettleFrameRef.current !== null) {
        cancelAnimationFrame(disclosureSettleFrameRef.current);
      }
      if (disclosureSettleSecondFrameRef.current !== null) {
        cancelAnimationFrame(disclosureSettleSecondFrameRef.current);
      }
    };
  }, []);

  const settleDisclosureAfterLayout = useCallback(() => {
    if (disclosureSettleFrameRef.current !== null) {
      cancelAnimationFrame(disclosureSettleFrameRef.current);
    }
    if (disclosureSettleSecondFrameRef.current !== null) {
      cancelAnimationFrame(disclosureSettleSecondFrameRef.current);
    }
    disclosureSettleFrameRef.current = requestAnimationFrame(() => {
      disclosureSettleSecondFrameRef.current = requestAnimationFrame(() => {
        // A disclosure can leave the reader above the end without a drag.
        // Reconcile follow before a later layout or resume can re-pin it.
        const listState = props.listRef.current?.getState();
        if (listState) {
          transitionEndFollow({
            type: "disclosure-settled",
            isAtEnd: listState.isAtEnd,
            userScrollSessionActive: userScrollSessionRef.current,
          });
        }
        disclosureAnchorKeyRef.current = null;
        setDisclosureToggleSettling(false);
        disclosureSettleFrameRef.current = null;
        disclosureSettleSecondFrameRef.current = null;
      });
    });
  }, [props.listRef, transitionEndFollow]);

  const suspendEndScrollMaintenanceForDisclosure = useCallback(
    (anchorKey: string | null) => {
      endOpeningPin();
      disclosureAnchorKeyRef.current = anchorKey;
      setDisclosureToggleSettling(true);
    },
    [endOpeningPin],
  );

  // Start the quiet-frame countdown after React has committed the disclosure.
  // Every measured item-size change restarts it, so end maintenance cannot
  // wake between the data mutation and LegendList's final layout correction.
  useLayoutEffect(() => {
    if (disclosureAnchorKeyRef.current !== null) {
      settleDisclosureAfterLayout();
    }
  }, [expandedTurnIds, expandedWorkGroups, expandedWorkRows, settleDisclosureAfterLayout]);

  const handleItemSizeChanged = useCallback(() => {
    if (disclosureAnchorKeyRef.current !== null) {
      settleDisclosureAfterLayout();
    }
    pinOpeningToEnd();
  }, [pinOpeningToEnd, settleDisclosureAfterLayout]);
  useEffect(() => {
    pinOpeningToEnd();
  }, [pinOpeningToEnd, presentedFeed, viewportHeight]);

  const shouldRestoreVisibleContentPosition = useCallback((entry: ThreadFeedEntry) => {
    const disclosureAnchorKey = disclosureAnchorKeyRef.current;
    return disclosureAnchorKey === null || entry.id === disclosureAnchorKey;
  }, []);

  const maintainVisibleContentPosition = useMemo(
    () => ({
      data: true,
      size: true,
      shouldRestorePosition: shouldRestoreVisibleContentPosition,
    }),
    [shouldRestoreVisibleContentPosition],
  );

  const onCopyWorkRow = useCallback((rowId: string, value: string) => {
    copyTextWithHaptic(value, {
      target: "thread-work-row",
      feedback: "selection",
    });
    setInteractionState((current) => ({ ...current, copiedRowId: rowId }));
    if (copyFeedbackTimeoutRef.current) {
      clearTimeout(copyFeedbackTimeoutRef.current);
    }
    copyFeedbackTimeoutRef.current = setTimeout(() => {
      setInteractionState((current) =>
        current.copiedRowId === rowId ? { ...current, copiedRowId: null } : current,
      );
      copyFeedbackTimeoutRef.current = null;
    }, 1200);
  }, []);

  const onToggleWorkGroup = useCallback(
    (groupId: string, anchorKey?: string) => {
      suspendEndScrollMaintenanceForDisclosure(anchorKey ?? `work-toggle:${groupId}`);
      setInteractionState((current) => ({
        ...current,
        expandedWorkGroups: {
          ...current.expandedWorkGroups,
          [groupId]: !(current.expandedWorkGroups[groupId] ?? false),
        },
      }));
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );

  const onToggleWorkRow = useCallback(
    (rowId: string, anchorKey?: string, shownExpanded?: boolean) => {
      suspendEndScrollMaintenanceForDisclosure(anchorKey ?? null);
      setInteractionState((current) => ({
        ...current,
        expandedWorkRows: {
          ...current.expandedWorkRows,
          [rowId]: !(shownExpanded ?? current.expandedWorkRows[rowId] ?? false),
        },
      }));
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );

  const onToggleTurnFold = useCallback(
    (runId: RunId) => {
      suspendEndScrollMaintenanceForDisclosure(`run-fold:${runId}`);
      setInteractionState((current) => {
        const next = new Set(current.expandedTurnIds);
        if (next.has(runId)) {
          next.delete(runId);
        } else {
          next.add(runId);
        }
        return { ...current, expandedTurnIds: next };
      });
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );

  const onPressPreview = useCallback((source: FilePreviewSource) => {
    setExpandedFile((current) => current ?? source);
  }, []);
  const onPressVideo = useCallback(
    (attachment: ChatFileAttachment, sourceIdentifier: string) => {
      setExpandedVideo(
        (current) =>
          current ??
          attachmentVideoPreviewSource(props.environmentId, attachment, sourceIdentifier),
      );
    },
    [props.environmentId],
  );

  // Rows whose height is known before they ever render. Without this, every
  // row above the viewport is assumed to be estimatedItemSize tall, and
  // scrolling up through unmeasured content corrects each row's height as it
  // mounts — the feed visibly jumps. Fixed sizes make the small chrome rows
  // exact; message rows stay undefined and use LegendList's per-type running
  // average once one of their type has been measured. Prominent v2 items,
  // expanded details, and compaction rows retain native measurement; their
  // cards and related-thread links can exceed the compact row height.
  const getFixedItemSize = useCallback(
    (entry: ThreadFeedEntry) => {
      if (discord || decorations.has(entry.id)) return undefined;
      if (entry.type === "html-render") {
        return htmlRenderRowHeight(htmlRenderFrameHeight(entry.render, contentWidth));
      }
      if (workRowSizing.fixedRowHeight === undefined) {
        return undefined;
      }
      switch (entry.type) {
        case "run-fold":
        case "thinking":
          return resolveThreadFeedFixedItemSize(entry.type);
        case "work-toggle":
          return resolveThreadFeedFixedItemSize(entry.type, {
            inlineImages: workGroupImageSources(entry.activities).length > 0,
          });
        case "activity-group":
          if (
            entry.activities.some(
              ({ projectedItem: { item } }) =>
                item.type === "subagent" ||
                (item.type === "notification" &&
                  notificationChildThreadId(item.source) !== undefined),
            )
          ) {
            return undefined;
          }
          if (isContextCompactionActivityGroup(entry) || isContextHandoffActivityGroup(entry)) {
            return undefined;
          }
          // Expanded rows append a variable detail block — fall back to
          // measurement for those groups.
          return entry.activities.some(
            (activity) => activity.prominent || expandedWorkRows[activity.id],
          )
            ? undefined
            : collapsedWorkLogHeight(entry.activities, entry.continuesWorkLog);
        default:
          return undefined;
      }
    },
    [contentWidth, expandedWorkRows, workRowSizing.fixedRowHeight, discord, decorations],
  );
  // HTML render rows' fixed heights follow the width, so a rotation or split
  // resize drops the cached sizes, as a text-size change does.
  const hasHtmlRenders = presentedFeedSummary.hasHtmlRenders;
  const previousContentWidth = useRef(contentWidth);
  useLayoutEffect(() => {
    if (previousContentWidth.current === contentWidth) return;
    previousContentWidth.current = contentWidth;
    if (hasHtmlRenders) props.listRef.current?.clearCaches({ mode: "sizes" });
  }, [contentWidth, hasHtmlRenders, props.listRef]);

  const sharedRowContext = useMemo<ThreadFeedSharedRowContextValue>(
    () => ({
      environmentId: props.environmentId,
      onSendSteerNow: props.onSendSteerNow,
      onEditPendingMessage: props.onEditPendingMessage,
      onUseArtifactTemplate: props.onUseArtifactTemplate,
      onQuoteMessage: props.onQuoteMessage,
      agentLabel: props.agentLabel,
      agentDriver: props.agentDriver,
      threadId: props.threadId,
      workRowSizing,
      workGroupScrollPositions,
      onCopyWorkRow,
      onToggleWorkGroup,
      onToggleWorkRow,
      onToggleTurnFold,
      onToggleAgentMessage: suspendEndScrollMaintenanceForDisclosure,
      onDisclosureLayout: settleDisclosureAfterLayout,
      onPressPreview,
      onPressVideo,
      markdownLinkHandlers,
      renderMarkdownImage,
      renderMarkdownImageGroup,
      renderViewedImage,
      renderReasoning,
      iconSubtleColor,
      screenColor,
      userBubbleColor,
      markdownStyles,
      reviewCommentColors,
      reviewCommentBubbleWidth,
      harnessView,
      discord,
      casualVoice,
      themeAppearance,
      usesNativeWorkspaceColumns,
      userBubbleMaxWidth,
      markdownContentWidth,
      contentWidth,
      threadTitle: props.threadTitle,
      skills: props.skills,
      workspaceRoot: props.workspaceRoot,
      draftKey: props.draftKey,
      canOperateMessage: props.canOperateMessage,
      supportsRollback: props.supportsRollback,
      rewindInProgress: props.rewindInProgress,
      onRewindingChange: props.onRewindingChange,
    }),
    [
      props.environmentId,
      props.onSendSteerNow,
      props.onEditPendingMessage,
      props.onUseArtifactTemplate,
      props.onQuoteMessage,
      props.agentLabel,
      props.agentDriver,
      props.threadId,
      workRowSizing,
      workGroupScrollPositions,
      onCopyWorkRow,
      onToggleWorkGroup,
      onToggleWorkRow,
      onToggleTurnFold,
      suspendEndScrollMaintenanceForDisclosure,
      settleDisclosureAfterLayout,
      onPressPreview,
      onPressVideo,
      markdownLinkHandlers,
      renderMarkdownImage,
      renderMarkdownImageGroup,
      renderViewedImage,
      renderReasoning,
      iconSubtleColor,
      screenColor,
      userBubbleColor,
      markdownStyles,
      reviewCommentColors,
      reviewCommentBubbleWidth,
      harnessView,
      discord,
      casualVoice,
      themeAppearance,
      usesNativeWorkspaceColumns,
      userBubbleMaxWidth,
      markdownContentWidth,
      contentWidth,
      props.threadTitle,
      props.skills,
      props.workspaceRoot,
      props.draftKey,
      props.canOperateMessage,
      props.supportsRollback,
      props.rewindInProgress,
      props.onRewindingChange,
    ],
  );

  const setupAnchorRowId =
    setupAnchorIndex >= 0 ? (presentedFeed[setupAnchorIndex]?.id ?? null) : null;
  const rowStoreState: ThreadFeedRowStoreState = {
    copiedRowId,
    expandedWorkRows,
    dispatchingMessageId: props.dispatchingMessageId,
    steerWait: props.steerWait ?? null,
    unsettledTurnId,
    terminalAssistantMessageIds,
    failedRunIds,
    decorations,
    agentAvatars: props.agentAvatars,
    worktreeSetup: props.worktreeSetup ?? null,
    setupWorkingStartedAt: props.setupWorkingStartedAt ?? null,
    setupAnchorRowId,
    messageRunActive: props.messageRunActive,
    disclosureToggleSettling,
  };
  const [rowStore] = useState(() => createThreadFeedRowStore(rowStoreState));
  useLayoutEffect(() => {
    rowStore.commitSnapshot(rowStoreState);
  });

  // Stable renderItem — zero closure deps. Rows are memoized by item identity
  // (not list index) and subscribe to shared appearance via
  // ThreadFeedSharedRowContext and to their own volatile slice via
  // ThreadFeedRowStoreContext so streaming updates, disclosures, history
  // prepends, and per-row interactions only re-render affected rows.
  const renderItem = useCallback(
    (info: { item: PendingThreadFeedEntry }) => <ThreadFeedRow item={info.item} />,
    [],
  );

  if (props.contentPresentation.kind === "unavailable" && props.queuedMessages.length === 0) {
    return (
      <ThreadFeedPlaceholder
        title={props.contentPresentation.title}
        detail={props.contentPresentation.detail}
        topInset={topContentInset}
        bottomInset={bottomContentInset}
        horizontalPadding={horizontalPadding}
      />
    );
  }

  // On iPhone a re-open pushes a fresh screen with data already available.
  // Measure before mounting the list so its first end scroll uses the real viewport.
  if (waitingForViewport) {
    return (
      <PresentationSource identifier={fileShareSourceIdentifier} style={{ flex: 1 }}>
        <View className="flex-1" onLayout={handleViewportLayout} />
      </PresentationSource>
    );
  }

  return (
    <PresentationSource identifier={fileShareSourceIdentifier} style={{ flex: 1 }}>
      <View className="flex-1" onLayout={handleViewportLayout}>
        <View className="flex-1">
          <FilePreviewGallery value={threadGallery}>
            <ThreadFeedSharedRowContext value={sharedRowContext}>
              <ThreadFeedRowStoreContext value={rowStore}>
                <KeyboardAwareLegendList
                  ref={props.listRef}
                  onLoad={({ elapsedTimeInMs }) => {
                    if (presentedFeed.length === 0) return;
                    if (isPhone) setLoadedListKey(listMountKey);
                    // LegendList has laid out its initial containers and completed
                    // the initial scroll. This measures render readiness, not GPU paint.
                    markLoad("chat.feed.layout", {
                      environment: props.environmentId.slice(0, 8),
                      thread: props.threadId.slice(0, 8),
                      rows: presentedFeed.length,
                      listMs: elapsedTimeInMs,
                    });
                  }}
                  // The empty↔filled key remounts the list when messages first
                  // arrive. LegendList's maintainScrollAtEnd calls scrollToEnd(),
                  // which is blind to UIKit's adjustedContentInset — inserting into
                  // an already-attached list under a transparent header can pin
                  // short content at offset 0 (one header-height too high). A fresh
                  // mount positions during attach, where UIKit applies the inset.
                  key={listMountKey}
                  style={{ flex: 1 }}
                  // RN 0.81+ drops touches inside the contentInset area
                  // (facebook/react-native#54123); the anchored end space after a send
                  // is pure inset, so without this the blank region can't be scrolled.
                  applyWorkaroundForContentInsetHitTestBug
                  // Horizontal Duo reservations are already included in the row padding.
                  // Let UIKit adjust the scrolling axis without shifting content sideways.
                  contentInsetAdjustmentBehavior={
                    usesNativeAutomaticInsets
                      ? usesNativeWorkspaceColumns &&
                        Platform.OS === "ios" &&
                        !Platform.isPad &&
                        props.layoutVariant === "split"
                        ? "scrollableAxes"
                        : "automatic"
                      : "never"
                  }
                  automaticallyAdjustsScrollIndicatorInsets={usesNativeAutomaticInsets}
                  {...(usesNativeAutomaticInsets
                    ? {
                        // Do NOT pass a manual `contentInset` here. Like the Home
                        // ScrollView, we rely purely on `contentInsetAdjustmentBehavior:
                        // "automatic"` so UIKit derives the top inset from the transparent
                        // header. A manual contentInset (which LegendList consumes into its
                        // own layout math) collapses the scroll view's adjustedContentInset
                        // top to 0, leaving the iOS 26/27 scroll-edge effect no region to
                        // render into — which is why the header blur was missing on threads.
                        scrollIndicatorInsets: { top: 0, left: 0, right: 0, bottom: 0 },
                      }
                    : { scrollIndicatorInsets: { top: topContentInset, bottom: 0 } })}
                  {...(anchoredEndSpace ? { anchoredEndSpace } : {})}
                  // Patched LegendList prop (patches/@legendapp__list@3.2.0.patch):
                  // lets its scroll math clamp programmatic scrolls to -headerInset
                  // instead of 0, so initialScrollAtEnd/maintainScrollAtEnd on short
                  // content rest below the transparent header rather than at frame top.
                  contentInsetStartAdjustment={usesNativeAutomaticInsets ? anchorTopInset : 0}
                  contentInsetEndAdjustment={props.contentInsetEndAdjustment}
                  // UIKit's automatic behavior adds the safe-area bottom on top of the
                  // raw contentInset the keyboard integration writes. The detail screen
                  // under-reports the composer inset by this amount (see
                  // ThreadDetailScreen); this tells LegendList's scroll math about the
                  // extra so programmatic end scrolls land at the true resting offset.
                  contentInsetEndStaticAdjustment={usesNativeAutomaticInsets ? insets.bottom : 0}
                  // Android's initial end scroll can run before the keyboard integration
                  // reports the composer height. Seed that estimate for LegendList's
                  // scroll math until the first reported inset replaces it.
                  {...(initialContentInset ? { contentInset: initialContentInset } : {})}
                  // The keyboard integration's offset math (end pinning, max scroll)
                  // must add the same UIKit-added extra, or its keyboard-open end
                  // targets land one safe-area short of the true resting offset.
                  adjustedInsetCompensation={usesNativeAutomaticInsets ? insets.bottom : 0}
                  freeze={props.freeze}
                  // Follow the measured end immediately. Animating toward an estimated
                  // end races row measurement when a pending message is acknowledged.
                  maintainScrollAtEnd={
                    disclosureToggleSettling || !endFollowEnabled
                      ? false
                      : {
                          animated: false,
                          on: {
                            dataChange: true,
                            itemLayout: true,
                            layout: true,
                          },
                        }
                  }
                  maintainVisibleContentPosition={
                    endFollowEnabled && !disclosureToggleSettling
                      ? false
                      : maintainVisibleContentPosition
                  }
                  data={presentedFeed}
                  renderItem={renderItem}
                  viewabilityConfig={THREAD_MEDIA_VIEWABILITY_CONFIG}
                  keyExtractor={threadFeedKeyExtractor}
                  getItemType={threadFeedGetItemType}
                  getFixedItemSize={getFixedItemSize}
                  // Virtualized rows must move with their measurements. Native layout
                  // transitions can retain stale positions during sync, even at duration 0.
                  onItemSizeChanged={handleItemSizeChanged}
                  // The initial end scroll renders the whole draw distance. Once the
                  // first viewport is visible, premeasure farther ahead for scrolling.
                  drawDistance={isPhone && loadedListKey !== listMountKey ? 50 : 500}
                  keyboardShouldPersistTaps="always"
                  keyboardDismissMode="none"
                  keyboardLiftBehavior="whenAtEnd"
                  // Seed the list's scroll math with the real viewport before its own
                  // onLayout: the empty→filled remount can then tell at mount that
                  // short content underflows the viewport and skip programmatic
                  // positioning entirely (any offset write during screen attach races
                  // UIKit's adjustedContentInset application and lands high or low).
                  {...(viewportHeight > 0 && viewportWidth > 0
                    ? { estimatedListSize: { height: viewportHeight, width: viewportWidth } }
                    : {})}
                  // RN's native scrollTo command clamps targets to a floor of
                  // -contentInset.top using the RAW inset — under automatic insets the
                  // header inset only exists in adjustedContentInset, so scrolls to
                  // negative offsets (content top below the transparent header) get
                  // clamped to 0. This prop disables that clamp; UIKit still bounces
                  // user overscroll back to the adjusted rest position.
                  scrollToOverflowEnabled
                  estimatedItemSize={180}
                  // Chat-style bottom alignment: when a thread is shorter than the
                  // viewport, pad above the content so messages rest just above the
                  // composer instead of under the header. No effect on threads that
                  // overflow the viewport (the padding clamps to zero).
                  alignItemsAtEnd
                  initialScrollAtEnd
                  onScroll={handleScroll}
                  onScrollBeginDrag={handleScrollBeginDrag}
                  onScrollEndDrag={handleScrollEndDrag}
                  onMomentumScrollBegin={handleMomentumScrollBegin}
                  onMomentumScrollEnd={handleMomentumScrollEnd}
                  scrollEventThrottle={16}
                  ListHeaderComponent={
                    <>
                      {usesNativeAutomaticInsets ? null : (
                        <View style={{ height: topContentInset }} />
                      )}
                      {setupAnchorIndex < 0 && props.worktreeSetup ? (
                        <WorktreeSetupCard key={props.threadId} {...props.worktreeSetup} />
                      ) : null}
                      {props.historyControls ? (
                        <ThreadFeedLoadEarlierControl {...props.historyControls} />
                      ) : null}
                    </>
                  }
                  ListFooterComponent={
                    props.pendingHandoff ? (
                      <ThreadHandoffDivider
                        environmentId={props.environmentId}
                        endpoints={props.pendingHandoff}
                        iconColor={iconSubtleColor}
                        label="Context handoff pending"
                        pending
                      />
                    ) : null
                  }
                  contentContainerStyle={{
                    paddingTop: 12,
                    paddingLeft: contentHorizontalPadding + contentLeftInset,
                    paddingRight: contentHorizontalPadding + contentRightInset,
                  }}
                />
              </ThreadFeedRowStoreContext>
            </ThreadFeedSharedRowContext>
          </FilePreviewGallery>
        </View>
        {presentedFeed.length === 0 &&
        !props.worktreeSetup &&
        props.activeWorkStartedAt === null &&
        props.contentPresentation.kind === "ready" ? (
          <View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { left: contentLeftInset, right: contentRightInset }]}
          >
            <ThreadFeedPlaceholder
              title="No conversation yet"
              detail="Ask the agent to inspect the repo, run a command, or continue the active chat."
              topInset={topContentInset}
              bottomInset={bottomContentInset}
              horizontalPadding={horizontalPadding}
            />
          </View>
        ) : null}
        <VideoPreviewModal source={expandedVideo} onRequestClose={() => setExpandedVideo(null)} />
        <FilePreviewModal source={expandedFile} onRequestClose={() => setExpandedFile(null)} />
      </View>
    </PresentationSource>
  );
});

function ThreadFeedLoadEarlierControl(props: ThreadFeedHistoryControls) {
  const theme = useUniwindTheme();
  const mutedColor = theme["--color-icon-subtle"];
  const accentColor = theme["--color-primary"];
  if (!props.hasMoreHistory && props.error === null) {
    return null;
  }
  return (
    <View className="mb-3 items-center gap-1.5 px-2">
      {props.hasMoreHistory ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Load earlier activity"
          disabled={props.loading}
          onPress={props.onLoadEarlier}
          className="min-h-9 flex-row items-center justify-center gap-2 rounded-full border border-border/60 bg-card/80 px-4 py-2 disabled:opacity-50"
        >
          {props.loading ? (
            <AppActivityIndicator size="small" color={accentColor} />
          ) : (
            <SymbolView name="chevron.up" size={12} tintColor={accentColor} type="monochrome" />
          )}
          <Text className="text-sm font-medium text-foreground">
            {props.loading ? "Loading earlier activity…" : "Load earlier activity"}
          </Text>
        </Pressable>
      ) : null}
      {props.error !== null ? (
        <Text className="text-center text-xs" style={{ color: mutedColor }}>
          {props.error}
        </Text>
      ) : null}
    </View>
  );
}
