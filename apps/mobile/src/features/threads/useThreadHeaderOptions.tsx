import { usePrivacyLabel, usePrivacyMode } from "../../state/use-privacy-mode";
import { sendToBotLabel } from "@t3tools/client-runtime/state/bots";
import { BotHeaderTitle, BotParkedHeaderTitle } from "../bots/BotChat";
import {
  useBotEntries,
  useBotForThread,
  useBotRuntime,
  useOptionalBotStatus,
  useParkedBotForThread,
} from "../bots/state";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useUiMode } from "../discord/useUiMode";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useMemo } from "react";
import { Platform, useWindowDimensions } from "react-native";
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
import { useAtomValue } from "@effect/atom-react";
import { teamBoardHistory, teamBoardHistoryLabel } from "@t3tools/client-runtime/state/team-board";
import { teamBoardEnvironment } from "../../state/teamBoard";
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
  const { width: windowWidth } = useWindowDimensions();
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
  const teamBoardSummary = useAtomValue(
    teamBoardEnvironment.summaryAtom(
      scopeThreadRef(
        EnvironmentId.make(props.gitControls.environmentId),
        ThreadId.make(props.gitControls.threadId),
      ),
    ),
  );
  // Past pushes for the list, or the one ended board a server without history keeps.
  const teamBoardPast = teamBoardHistory(teamBoardSummary);
  const teamBoardMenuLabel =
    teamBoardPast === null
      ? null
      : teamBoardHistoryLabel(teamBoardPast, teamBoardSummary?.postCount ?? 0);
  const teamBoardMenuList = teamBoardPast?.kind === "pushes";
  // The chat's overflow menu. A live push opens from its pill and presence chips; past pushes
  // stay here, read-only, even while a new one runs.
  const moreHeaderItem = useMemo(
    () =>
      teamBoardMenuLabel !== null
        ? {
            accessibilityLabel: "More",
            icon: { name: "ellipsis.circle", type: "sfSymbol" },
            identifier: "thread-right-more",
            label: "More",
            menu: {
              items: [
                {
                  description: teamBoardMenuLabel,
                  icon: { name: "bubble.left.and.text.bubble.right", type: "sfSymbol" as const },
                  label: "Team board",
                  onPress: () =>
                    navigation.navigate("ThreadTeamBoard", {
                      environmentId: EnvironmentId.make(props.gitControls.environmentId),
                      threadId: ThreadId.make(props.gitControls.threadId),
                      ...(teamBoardMenuList ? { history: true } : {}),
                    }),
                  type: "action" as const,
                },
              ],
            },
            sharesBackground: true,
            type: "menu",
            variant: "plain",
          }
        : null,
    [
      teamBoardMenuLabel,
      teamBoardMenuList,
      navigation,
      props.gitControls.environmentId,
      props.gitControls.threadId,
    ],
  );
  // A bot's home chat shows the bot in the title and opens its info sheet; any other chat
  // can be sent to a bot on the same machine.
  const headerEnvironmentId = EnvironmentId.make(props.gitControls.environmentId);
  const headerThreadId = ThreadId.make(props.gitControls.threadId);
  const bot = useBotForThread(headerEnvironmentId, headerThreadId);
  // With Bots off the bot's chat still opens; its title is the bot, never its folder.
  const parkedBot = useParkedBotForThread(headerEnvironmentId, headerThreadId);
  const botRuntime = useBotRuntime(bot);
  const botStatus = useOptionalBotStatus(bot, botRuntime);
  const botEntries = useBotEntries();
  const sendTargets = useMemo(
    () =>
      bot === null ? botEntries.filter((entry) => entry.environmentId === headerEnvironmentId) : [],
    [bot, botEntries, headerEnvironmentId],
  );
  const botId = bot?.bot.id;
  const botHeaderItems = useMemo<NativeHeaderItems>(() => {
    if (botId !== undefined)
      return [
        {
          accessibilityLabel: "Bot info",
          icon: { name: "info.circle", type: "sfSymbol" },
          identifier: "thread-bot-info",
          label: "Info",
          onPress: () =>
            navigation.navigate("BotInfo", {
              environmentId: String(headerEnvironmentId),
              botId,
            }),
          type: "button",
        },
      ];
    if (sendTargets.length === 0) return [];
    return [
      {
        accessibilityLabel: "More",
        icon: { name: "ellipsis.circle", type: "sfSymbol" },
        identifier: "thread-bot-send",
        label: "More",
        menu: {
          items: sendTargets.map((entry) => ({
            icon: { name: "paperplane", type: "sfSymbol" as const },
            label: sendToBotLabel(entry.bot.name),
            onPress: () =>
              navigation.navigate("BotSend", {
                environmentId: String(entry.environmentId),
                botId: entry.bot.id,
                threadId: String(headerThreadId),
              }),
            type: "action" as const,
          })),
        },
        type: "menu",
      },
    ];
  }, [botId, headerEnvironmentId, headerThreadId, navigation, sendTargets]);
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
      ...botHeaderItems,
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
      ...(moreHeaderItem ? [moreHeaderItem] : []),
    ],
    [
      botHeaderItems,
      computerUseStatus,
      onMergeBack,
      props.onOpenMedia,
      props.onFindInChat,
      pinnedHeaderItem,
      moreHeaderItem,
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

  const botTitleWidth = Math.max(160, windowWidth - 200);
  const options: AppNativeStackNavigationOptions = {
    headerShown: true,
    headerTitle:
      bot !== null && botStatus !== null
        ? () => (
            <BotHeaderTitle
              entry={bot}
              status={botStatus}
              maxWidth={botTitleWidth}
              onPress={() =>
                navigation.navigate("BotInfo", {
                  environmentId: String(bot.environmentId),
                  botId: bot.bot.id,
                })
              }
            />
          )
        : parkedBot !== null
          ? () => <BotParkedHeaderTitle entry={parkedBot} maxWidth={botTitleWidth} />
          : discord
            ? `# ${title}`
            : title,
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
    unstable_headerSubtitle:
      props.usesNativeHeaderGlass && bot === null && parkedBot === null
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
      bot?.bot,
      parkedBot?.bot,
      botStatus?.kind,
      botStatus?.label,
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
