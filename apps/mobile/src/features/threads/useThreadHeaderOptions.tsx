import { usePrivacyLabel, usePrivacyMode } from "../../state/use-privacy-mode";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useUiMode } from "../discord/useUiMode";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useMemo } from "react";
import { Platform } from "react-native";
import type { AppNativeStackNavigationOptions } from "../../native/StackHeader";
import { useNativeWorkspaceColumnsSupported } from "../../native/NativeWorkspaceColumns";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { dispatchHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useComputerUseStatus } from "../computer-use/useComputerUseStatus";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { pendingThreadSearchJumpAtom } from "@t3tools/client-runtime/state/thread-search";
import { appAtomRegistry } from "../../state/atom-registry";
import { useThreadShell } from "../../state/entities";
import { formatTranscriptTimestamp } from "../../lib/time";
import {
  type ThreadGitControls,
  useThreadGitCenterHeaderItems,
  useThreadGitRightHeaderItems,
} from "./ThreadGitControls";

type NativeHeaderItems = ReadonlyArray<Record<string, unknown>>;

/** A pin's preview as one menu line; the menu itself cuts what still runs long. */
function pinMenuLabel(preview: string | undefined): string {
  if (!preview) return "Agent message";
  return preview.length <= 90 ? preview : `${preview.slice(0, 89).trimEnd()}…`;
}

/** The thread's side chat (`/btw` on Claude, `/side` on Codex), when its agent has one. */
export interface ThreadHeaderSideChat {
  readonly label: string;
  readonly onOpen: () => void;
}

export function useThreadHeaderOptions(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly headerColor: string;
  readonly usesNativeHeaderGlass: boolean;
  readonly gitControls: Parameters<typeof ThreadGitControls>[0];
  readonly onReturnToThread?: () => void;
  readonly sideChat?: ThreadHeaderSideChat | null;
  readonly onOpenMedia?: (() => void) | undefined;
  readonly onFindInChat?: (() => void) | undefined;
}) {
  const privateLabel = usePrivacyLabel();
  const privacy = usePrivacyMode();
  const title = privateLabel("Chat", props.gitControls.threadId, props.title);
  const usesNativeWorkspaceColumns = useNativeWorkspaceColumnsSupported();
  const usesDuoHeader = usesNativeWorkspaceColumns && Platform.OS === "ios" && !Platform.isPad;
  const navigation = useNavigation();
  const [uiMode] = useUiMode();
  const discord = uiMode === "discord";
  const { layout, panes, togglePrimarySidebar } = useAdaptiveWorkspaceLayout();
  const { threadHeaderItems: visibleHeaderItems } = useAppearancePreferences();
  const gitCenterHeaderItems = useThreadGitCenterHeaderItems(props.gitControls, visibleHeaderItems);
  const gitRightHeaderItems = useThreadGitRightHeaderItems(props.gitControls, visibleHeaderItems);
  const computerUseStatus = useComputerUseStatus(
    EnvironmentId.make(props.gitControls.environmentId),
    ThreadId.make(props.gitControls.threadId),
  );
  const headerThread = useThreadShell(
    scopeThreadRef(
      EnvironmentId.make(props.gitControls.environmentId),
      ThreadId.make(props.gitControls.threadId),
    ),
  );
  const pinnedMessages = headerThread?.pinnedMessages;
  const headerProjectId = headerThread?.projectId;
  // Shown only while the chat has a pin; newest pin first, each one jumps to its message.
  const pinnedHeaderItem = useMemo(() => {
    if (!pinnedMessages || pinnedMessages.length === 0 || !headerProjectId) return null;
    const environmentId = EnvironmentId.make(props.gitControls.environmentId);
    const threadId = ThreadId.make(props.gitControls.threadId);
    const label =
      pinnedMessages.length === 1 ? "1 pinned message" : `${pinnedMessages.length} pinned messages`;
    return {
      accessibilityLabel: label,
      icon: { name: "pin", type: "sfSymbol" },
      identifier: "thread-right-pinned",
      label: "Pinned",
      menu: {
        items: [...pinnedMessages].reverse().map((pin) => ({
          description: `Pinned ${formatTranscriptTimestamp(pin.pinnedAt)}`,
          icon: { name: "pin", type: "sfSymbol" as const },
          label: pinMenuLabel(pin.preview),
          onPress: () =>
            appAtomRegistry.set(pendingThreadSearchJumpAtom, {
              environmentId,
              threadId,
              projectId: headerProjectId,
              source: "assistant",
              snippet: "",
              messageCreatedAt: null,
              messageId: pin.messageId,
            }),
          type: "action" as const,
        })),
        title: "Pinned messages",
      },
      sharesBackground: true,
      type: "menu",
      variant: "plain",
    };
  }, [
    headerProjectId,
    pinnedMessages,
    props.gitControls.environmentId,
    props.gitControls.threadId,
  ]);
  const sideChatLabel = props.sideChat?.label;
  const openSideChat = props.sideChat?.onOpen;
  const showsSideChat = visibleHeaderItems.includes("sideChat");
  const onMergeBack = props.gitControls.onMergeBack;
  // Joins the shortcut group, last so it sits under the thumb.
  const sideChatHeaderItem = useMemo(
    () =>
      showsSideChat && sideChatLabel && openSideChat
        ? {
            accessibilityLabel: sideChatLabel,
            icon: { name: "bubble.left.and.bubble.right", type: "sfSymbol" },
            identifier: "thread-right-side-chat",
            label: sideChatLabel,
            onPress: openSideChat,
            sharesBackground: true,
            type: "button",
            variant: "plain",
          }
        : null,
    [openSideChat, sideChatLabel, showsSideChat],
  );
  const contextualHeaderItems = useMemo<NativeHeaderItems>(
    () => [
      ...(computerUseStatus
        ? [
            {
              accessibilityLabel: computerUseStatus.label,
              label: computerUseStatus.label,
              identifier: "thread-computer-use",
              icon: { name: computerUseStatus.icon, type: "sfSymbol" },
              type: "button",
              onPress: computerUseStatus.openSettings,
              sharesBackground: true,
              variant: "plain",
            },
          ]
        : []),
      ...(props.onOpenMedia
        ? [
            {
              accessibilityLabel: "Media",
              label: "Media",
              identifier: "thread-media",
              icon: { name: "photo.on.rectangle", type: "sfSymbol" },
              type: "button",
              onPress: props.onOpenMedia,
            },
          ]
        : []),
      ...(props.onFindInChat
        ? [
            {
              accessibilityLabel: "Find in chat",
              label: "Find in chat",
              identifier: "thread-find",
              icon: { name: "text.magnifyingglass", type: "sfSymbol" },
              type: "button",
              onPress: props.onFindInChat,
            },
          ]
        : []),
      ...(discord
        ? [
            {
              accessibilityLabel: "Members",
              label: "Members",
              identifier: "thread-members",
              icon: { name: "person.2", type: "sfSymbol" },
              type: "button",
              onPress: () =>
                navigation.navigate("ThreadAgents", {
                  environmentId: EnvironmentId.make(props.gitControls.environmentId),
                  threadId: ThreadId.make(props.gitControls.threadId),
                }),
            },
          ]
        : []),
      ...(pinnedHeaderItem ? [pinnedHeaderItem] : []),
      ...(sideChatHeaderItem ? [sideChatHeaderItem] : []),
      ...(onMergeBack
        ? [
            {
              accessibilityLabel: "Merge back to source",
              icon: { name: "arrow.triangle.merge", type: "sfSymbol" },
              identifier: "thread-right-merge-back",
              label: "Merge back to source",
              onPress: onMergeBack,
              sharesBackground: true,
              type: "button",
              variant: "plain",
            },
          ]
        : []),
    ],
    [
      computerUseStatus,
      onMergeBack,
      props.onOpenMedia,
      props.onFindInChat,
      pinnedHeaderItem,
      sideChatHeaderItem,
      discord,
      navigation,
      props.gitControls.environmentId,
      props.gitControls.threadId,
    ],
  );
  const threadCenterHeaderItems = useMemo<NativeHeaderItems>(
    () => [...gitCenterHeaderItems, ...contextualHeaderItems],
    [gitCenterHeaderItems, contextualHeaderItems],
  );
  const compactRightHeaderItems = useMemo<NativeHeaderItems>(
    () => [...gitRightHeaderItems, ...contextualHeaderItems],
    [gitRightHeaderItems, contextualHeaderItems],
  );
  const splitLeftHeaderItems = useMemo<NativeHeaderItems>(
    () => [
      ...(!usesDuoHeader
        ? [
            {
              // Match Mail's split-view detail toolbar: the first detail action sits
              // inside the content pane, not flush against the sidebar divider.
              spacing: 18,
              type: "spacing" as const,
            },
          ]
        : []),
      ...(props.onReturnToThread
        ? [
            withNativeGlassHeaderItem({
              accessibilityLabel: "Return to chat",
              icon: { name: "chevron.left", type: "sfSymbol" as const },
              identifier: "thread-left-return",
              onPress: props.onReturnToThread,
              type: "button" as const,
            }),
          ]
        : []),
      withNativeGlassHeaderItem({
        axisBehavior: usesNativeWorkspaceColumns ? "horizontalOnly" : undefined,
        accessibilityLabel: panes.primarySidebarVisible ? "Maximize content" : "Show chat sidebar",
        icon: {
          name: panes.primarySidebarVisible ? "arrow.up.left.and.arrow.down.right" : "sidebar.left",
          type: "sfSymbol" as const,
        },
        identifier: "thread-left-sidebar",
        label: panes.primarySidebarVisible ? "Maximize content" : "Show chat sidebar",
        onPress: togglePrimarySidebar,
        type: "button" as const,
      }),
      ...(!usesDuoHeader
        ? [
            withNativeGlassHeaderItem({
              accessibilityLabel: "New task",
              icon: { name: "square.and.pencil", type: "sfSymbol" as const },
              identifier: "thread-left-new-task",
              label: "New task",
              onPress: () => navigation.navigate("NewTaskSheet", { screen: "NewTask" }),
              type: "button" as const,
            }),
          ]
        : []),
    ],
    [
      panes.primarySidebarVisible,
      props.onReturnToThread,
      navigation,
      togglePrimarySidebar,
      usesDuoHeader,
      usesNativeWorkspaceColumns,
    ],
  );
  // Deep links / cold starts land with Thread as the ONLY route, where the
  // native back button does not render. Provide an explicit Home escape for
  // that case; when history exists the native back button is used instead.
  const canGoBack = navigation.canGoBack();
  const compactHomeHeaderItems = useMemo<NativeHeaderItems>(
    () => [
      withNativeGlassHeaderItem({
        accessibilityLabel: "Go to chats list",
        icon: { name: "list.bullet", type: "sfSymbol" as const },
        identifier: "thread-left-home",
        onPress: () => navigation.dispatch(StackActions.replace("Home")),
        type: "button" as const,
      }),
    ],
    [navigation],
  );

  const duoRightHeaderItems = useMemo<NativeHeaderItems>(
    () => [
      ...threadCenterHeaderItems,
      ...(threadCenterHeaderItems.length > 0 ? [{ type: "spacing", spacing: 8 }] : []),
      ...(layout.usesSplitView &&
      Platform.OS === "ios" &&
      !Platform.isPad &&
      !panes.primarySidebarVisible
        ? [
            withNativeGlassHeaderItem({
              type: "button" as const,
              axisBehavior: "verticalPreferred",
              identifier: "thread-right-search",
              label: "Search chats",
              accessibilityLabel: "Search chats",
              icon: { name: "magnifyingglass", type: "sfSymbol" as const },
              onPress: () => {
                dispatchHardwareKeyboardCommand("focusSearch");
              },
            }),
          ]
        : []),
      withNativeGlassHeaderItem({
        type: "button" as const,
        axisBehavior: "verticalPreferred",
        identifier: "thread-right-new-task",
        label: "New task",
        accessibilityLabel: "New task",
        icon: { name: "square.and.pencil", type: "sfSymbol" as const },
        onPress: () => navigation.navigate("NewTaskSheet", { screen: "NewTask" }),
      }),
    ],
    [navigation, threadCenterHeaderItems, layout.usesSplitView, panes.primarySidebarVisible],
  );

  const options: AppNativeStackNavigationOptions = {
    headerShown: true,
    headerTitle: discord ? `# ${title}` : title,
    headerTitleStyle: props.usesNativeHeaderGlass
      ? {
          fontSize: 17,
          fontWeight: "800",
        }
      : undefined,
    title,
    headerBackVisible: !layout.usesSplitView,
    // Compact uses the NATIVE back button when a previous route exists;
    // deep links / cold starts get an explicit Home button instead.
    // Split view always uses its custom left items.
    unstable_headerLeftItems: layout.usesSplitView
      ? () => splitLeftHeaderItems
      : canGoBack
        ? undefined
        : () => compactHomeHeaderItems,
    // Search lives in the persistent sidebar, so the split header keeps
    // the git controls on the RIGHT (no center items — center space is
    // reserved for future breadcrumbs/status).
    unstable_headerRightItems: () =>
      usesDuoHeader
        ? duoRightHeaderItems
        : layout.usesSplitView
          ? threadCenterHeaderItems
          : compactRightHeaderItems,
    unstable_headerToolbarItems: () => [],
    unstable_headerSubtitle: props.usesNativeHeaderGlass
      ? privacy
        ? "Details hidden"
        : props.subtitle
      : undefined,
    contentStyle: undefined,
  };
  const { environmentId, threadId } = props.gitControls;
  return {
    options,
    visibleHeaderItems,
    // Header item factories are stabilized, so the native header only re-reads them when
    // this version changes. Keying on the items keeps menus (terminal, pinned) live.
    optionsVersion: [
      privacy,
      title,
      splitLeftHeaderItems,
      threadCenterHeaderItems,
      compactRightHeaderItems,
      duoRightHeaderItems,
      usesDuoHeader,
      environmentId,
      threadId,
    ],
    sidebar: false,
    // Native items work with and without Liquid Glass. A second toolbar would
    // overwrite the filtered items on older iOS versions.
    fallback: null,
  };
}
