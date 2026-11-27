import { usePrivacyLabel } from "../../state/use-privacy-mode";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ALL_CHATS_TAB, type ChatTabView } from "@t3tools/client-runtime/state/chat-tabs";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  CLAUDE_RC_TAB,
  cleanChatTabName,
  type ChatTabsCommand,
  type EnvironmentId,
} from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { Atom, AsyncResult } from "effect/reactivity";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { showTextInputDialog } from "../../components/ConfirmDialogHost";
import { cn } from "../../lib/cn";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import {
  chatListTabsEnabledAtom,
  environmentServerConfigsAtom,
  serverEnvironment,
} from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { resolveHomeChatTab } from "../terminalSessions/terminalSessions.logic";
import { buildHomeChatTabs } from "./ChatTabs.logic";

/**
 * Chat tabs on the phone: a row of chips above Home's list, All first, the same tabs the
 * Mac shows. Rows offer "Move to tab" in their menu. The open tab is this device's choice.
 */

/** The tabs Home shows, for row menus to offer. */
const chatTabViewsAtom = Atom.make<ReadonlyArray<ChatTabView>>([]).pipe(Atom.keepAlive);

/** Home's tabs and the open one, from the chats Home lists. */
export function useHomeChatTabs(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  connectionPhases: ReadonlyMap<EnvironmentId, EnvironmentConnectionPhase>,
  selectedMachine: string | null,
) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const configs = useAtomValue(environmentServerConfigsAtom);
  const tabs = useMemo(
    () =>
      buildHomeChatTabs(
        threads,
        connectionPhases,
        [...configs].flatMap(([environmentId, config]) =>
          selectedMachine === null || selectedMachine === environmentId
            ? (config.chatTabs ?? []).map((tab) => ({ environmentId, tab }))
            : [],
        ),
      ),
    [threads, connectionPhases, configs, selectedMachine],
  );
  // Row menus only need which chats each tab holds, so statuses changing does not
  // re-render every row.
  const membership = tabs
    .map((tab) => `${tab.key}\u0000${tab.name}\u0000${[...tab.threadKeys].join(",")}`)
    .join("\n");
  useEffect(() => {
    appAtomRegistry.set(chatTabViewsAtom, tabs);
  }, [membership]);
  const device = AsyncResult.isSuccess(preferences) ? preferences.value : undefined;
  const enabled = useAtomValue(chatListTabsEnabledAtom);
  const selected = enabled
    ? resolveHomeChatTab(device?.threadListChatTab ?? ALL_CHATS_TAB, tabs)
    : ALL_CHATS_TAB;
  const select = useCallback(
    (key: string) => {
      if (!enabled) return;
      void Haptics.selectionAsync();
      save({ threadListChatTab: key });
    },
    [enabled, save],
  );
  return { tabs, selected, select, enabled: enabled !== false };
}

/** The chips row. All and Terminal stay even when there are no named tabs. */
export function HomeChatTabs(props: {
  readonly tabs: ReadonlyArray<ChatTabView>;
  readonly selected: string;
  readonly onSelect: (key: string) => void;
  /** Shortcut chips that close the row, after the tabs. */
  readonly trailing?: ReactNode;
}) {
  const privateLabel = usePrivacyLabel();
  const chips = [
    { key: ALL_CHATS_TAB, name: "All", status: null as "attention" | "working" | null },
    ...props.tabs.map((tab) => ({
      key: tab.key,
      name: privateLabel("Tab", tab.key, tab.name),
      status: tab.attention ? ("attention" as const) : tab.working ? ("working" as const) : null,
    })),
    { key: CLAUDE_RC_TAB, name: "Terminal", status: null as "attention" | "working" | null },
  ];
  const pinned = props.trailing != null;
  const list = (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      // A scroll view grows by default: above an empty list it took half the screen, pushing
      // the empty state down and leaving the chips' divider stranded mid-screen.
      className="shrink grow-0"
      contentContainerClassName={cn("gap-1.5 pb-1.5 pl-4 pt-1", pinned ? "pr-2" : "pr-4")}
      accessibilityRole="tablist"
    >
      {chips.map((chip) => {
        const selected = chip.key === props.selected;
        return (
          <Pressable
            key={chip.key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={
              chip.status === "attention"
                ? `${chip.name}, a chat needs you`
                : chip.status === "working"
                  ? `${chip.name}, a chat is working`
                  : chip.name
            }
            onPress={() => props.onSelect(chip.key)}
            className={cn(
              "h-8 flex-row items-center gap-1.5 rounded-full border px-3.5 active:opacity-70",
              selected ? "border-border bg-grouped-card" : "border-transparent bg-subtle",
            )}
          >
            <Text
              numberOfLines={1}
              className={cn(
                "max-w-40 text-sm",
                selected ? "font-t3-medium text-foreground" : "text-foreground-muted",
              )}
            >
              {chip.name}
            </Text>
            {chip.status && !selected ? (
              <View
                className={cn(
                  "size-1.5 rounded-full",
                  chip.status === "attention" ? "bg-warning-foreground" : "bg-primary",
                )}
              />
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
  if (!pinned) return list;
  // Shortcuts (Overview) stay pinned at the trailing edge; the chips scroll under them.
  return (
    <View className="flex-row items-start">
      {list}
      <View className="h-8 flex-row items-center gap-1.5 pr-4 mt-1">{props.trailing}</View>
    </View>
  );
}

const MOVE = "chat-tab:move:";

/** "Move to tab" for a row's menu, and the handler for what was picked. */
export function useChatTabRowMenu(thread: EnvironmentThreadShell) {
  const tabs = useAtomValue(chatTabViewsAtom);
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const run = useAtomCommand(serverEnvironment.chatTabsCommand, {
    label: "chat tabs update",
    reportFailure: false,
  });
  const supported =
    serverConfigs.get(thread.environmentId)?.environment.capabilities.chatTabs === true;
  const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const currentKey = tabs.find((tab) => tab.threadKeys.has(threadKey))?.key ?? null;
  const action = useMemo<MenuAction | null>(
    () =>
      supported
        ? {
            id: "chat-tab",
            title: "Move to Tab",
            image: "rectangle.stack",
            subactions: [
              ...tabs.map((tab) => ({
                id: `${MOVE}${tab.key}`,
                title: tab.name,
                ...(tab.key === currentKey ? { state: "on" as const } : {}),
              })),
              { id: "chat-tab:new", title: "New Tab…", image: "plus" },
              ...(thread.source.chatTab != null
                ? [{ id: "chat-tab:remove", title: "Remove from Tab", image: "minus.circle" }]
                : []),
            ],
          }
        : null,
    [currentKey, supported, tabs, thread.source.chatTab],
  );
  const send = useCallback(
    (environmentId: EnvironmentId, input: ChatTabsCommand) =>
      void run({ environmentId, input }).then((result) => {
        if (result._tag === "Success") return;
        Alert.alert("Could not update tabs", "Check that the machine is connected and try again.");
      }),
    [run],
  );
  const handle = useCallback(
    (event: string): boolean => {
      if (!event.startsWith("chat-tab:")) return false;
      const move = (tab: string | null) =>
        send(thread.environmentId, { action: "move", threadIds: [thread.id], tab });
      if (event === "chat-tab:remove") move(null);
      else if (event.startsWith(MOVE)) {
        const tab = tabs.find((candidate) => candidate.key === event.slice(MOVE.length));
        if (tab) move(tab.name);
      } else if (event === "chat-tab:new") {
        const commit = (raw: string) => {
          const name = cleanChatTabName(raw);
          if (name.length > 0) move(name);
        };
        const initial = cleanChatTabName(thread.title);
        if (Platform.OS === "ios") {
          Alert.prompt("New tab", undefined, (name) => commit(name ?? ""), "plain-text", initial);
        } else {
          showTextInputDialog({
            title: "New tab",
            initialValue: initial,
            confirmText: "Create",
            onConfirm: commit,
          });
        }
      }
      return true;
    },
    [send, tabs, thread.environmentId, thread.id, thread.title],
  );
  return { action, handle };
}

/** True when a chat belongs in the open tab; every chat is in All. Terminal holds none. */
export function homeChatTabShows(
  selected: string,
  tabs: ReadonlyArray<ChatTabView>,
  thread: Pick<EnvironmentThreadShell, "environmentId" | "id">,
): boolean {
  if (selected === CLAUDE_RC_TAB) return false;
  if (selected === ALL_CHATS_TAB) return true;
  const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  return tabs.find((tab) => tab.key === selected)?.threadKeys.has(key) === true;
}
