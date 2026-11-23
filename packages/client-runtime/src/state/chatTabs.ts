/**
 * Chat tabs as clients show them: a strip of named groups above the chat list, "All" first.
 * Servers file each chat into a tab (`chatTab` on its shell); tabs with the same name on
 * different machines are one tab here. A tab shows once it holds two chats, or one the user
 * put there, so a stray one-chat tab never clutters the strip.
 */
import type { ChatTab, ChatTabIcon } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "./models.ts";

/** The strip's first tab: every chat. */
export const ALL_CHATS_TAB = "";

export type ChatTabStatus = "attention" | "working" | null;

export interface ChatTabView {
  /** The tab's identity across machines: its name, folded. */
  readonly key: string;
  readonly name: string;
  /** Chats in the tab, by scoped thread key. */
  readonly threadKeys: ReadonlySet<string>;
  /** Some chat in the tab waits on the user. */
  readonly attention: boolean;
  /** Some chat in the tab is working. */
  readonly working: boolean;
  readonly icon?: ChatTabIcon | undefined;
  readonly environmentIds?: ReadonlySet<string>;
}

export function chatTabKey(name: string): string {
  return name.trim().toLocaleLowerCase("en-US");
}

type TabbedThread = Pick<EnvironmentThreadShell, "environmentId" | "id" | "source">;

/** The tab a chat is filed in, folded, or null for none. */
export function chatTabKeyOf(thread: Pick<EnvironmentThreadShell, "source">): string | null {
  const tab = thread.source.chatTab;
  return tab == null ? null : chatTabKey(tab.name);
}

/**
 * The tabs to show for these chats (the ones the list would show), in strip order: by the
 * lowest position any machine gives the tab, then by name.
 */
export function buildChatTabs<Thread extends TabbedThread>(
  threads: ReadonlyArray<Thread>,
  options: {
    readonly threadKey: (thread: Thread) => string;
    readonly status: (thread: Thread) => ChatTabStatus;
    readonly catalog?: ReadonlyArray<{ readonly environmentId: string; readonly tab: ChatTab }>;
  },
): ReadonlyArray<ChatTabView> {
  const groups = new Map<
    string,
    {
      name: string;
      position: number;
      manual: boolean;
      threadKeys: Set<string>;
      attention: boolean;
      working: boolean;
      keepEmpty: boolean;
      environmentIds: Set<string>;
      icon?: ChatTabIcon;
    }
  >();
  for (const { environmentId, tab } of options.catalog ?? []) {
    const key = chatTabKey(tab.name);
    const previous = groups.get(key);
    groups.set(key, {
      name: previous?.name ?? tab.name,
      position: Math.min(previous?.position ?? tab.position, tab.position),
      manual: false,
      threadKeys: previous?.threadKeys ?? new Set(),
      attention: false,
      working: false,
      keepEmpty: (previous?.keepEmpty ?? false) || tab.keepEmpty === true,
      environmentIds: new Set([...(previous?.environmentIds ?? []), environmentId]),
      ...((previous?.icon ?? tab.icon) ? { icon: previous?.icon ?? tab.icon } : {}),
    });
  }
  for (const thread of threads) {
    const tab = thread.source.chatTab;
    if (tab == null) continue;
    const key = chatTabKey(tab.name);
    const group = groups.get(key) ?? {
      name: tab.name,
      position: tab.position,
      manual: false,
      threadKeys: new Set<string>(),
      attention: false,
      working: false,
      keepEmpty: false,
      environmentIds: new Set<string>(),
    };
    group.position = Math.min(group.position, tab.position);
    group.manual ||= tab.manual;
    group.environmentIds.add(thread.environmentId);
    group.threadKeys.add(options.threadKey(thread));
    const status = options.status(thread);
    group.attention ||= status === "attention";
    group.working ||= status === "working";
    groups.set(key, group);
  }
  return [...groups]
    .filter(([, group]) => group.threadKeys.size >= 2 || group.manual || group.keepEmpty)
    .sort(
      ([, left], [, right]) =>
        left.position - right.position || left.name.localeCompare(right.name),
    )
    .map(([key, group]) => ({
      key,
      name: group.name,
      threadKeys: group.threadKeys,
      attention: group.attention,
      working: group.working,
      ...(options.catalog === undefined ? {} : { environmentIds: group.environmentIds }),
      ...(group.icon === undefined ? {} : { icon: group.icon }),
    }));
}

/** The selected tab, or All when that tab is gone. */
export function resolveSelectedChatTab(
  selected: string,
  tabs: ReadonlyArray<Pick<ChatTabView, "key">>,
): string {
  return selected === ALL_CHATS_TAB || tabs.some((tab) => tab.key === selected)
    ? selected
    : ALL_CHATS_TAB;
}

/** Whether the list shows this chat while `selected` is the tab. */
export function chatTabShowsThread(
  selected: string,
  tabs: ReadonlyArray<ChatTabView>,
  threadKey: string,
): boolean {
  if (selected === ALL_CHATS_TAB) return true;
  return tabs.find((tab) => tab.key === selected)?.threadKeys.has(threadKey) === true;
}
