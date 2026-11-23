import type { ChatTabView } from "@t3tools/client-runtime/state/chat-tabs";
import type { ContextMenuItem } from "@t3tools/contracts";

/** Menu ids for chat tabs, kept apart from the thread actions they sit among. */
export type ChatTabMenuId = `chat-tab:${string}`;

const MOVE = "chat-tab:move:";
const MERGE = "chat-tab:merge:";

export function isChatTabMenuId(id: string | null): id is ChatTabMenuId {
  return id !== null && id.startsWith("chat-tab:");
}

export type ChatTabMenuAction =
  | { readonly kind: "move"; readonly key: string }
  | { readonly kind: "new" }
  | { readonly kind: "remove" }
  | { readonly kind: "rename" }
  | { readonly kind: "move-left" }
  | { readonly kind: "move-right" }
  | { readonly kind: "merge"; readonly key: string }
  | { readonly kind: "delete" };

export function parseChatTabMenuId(id: ChatTabMenuId): ChatTabMenuAction | null {
  if (id.startsWith(MOVE)) return { kind: "move", key: id.slice(MOVE.length) };
  if (id.startsWith(MERGE)) return { kind: "merge", key: id.slice(MERGE.length) };
  switch (id) {
    case "chat-tab:new":
      return { kind: "new" };
    case "chat-tab:remove":
      return { kind: "remove" };
    case "chat-tab:rename":
      return { kind: "rename" };
    case "chat-tab:move-left":
      return { kind: "move-left" };
    case "chat-tab:move-right":
      return { kind: "move-right" };
    case "chat-tab:delete":
      return { kind: "delete" };
    default:
      return null;
  }
}

/** "Move to tab" on chats: each tab (theirs checked), a new one, or out of their tab. */
export function moveToChatTabMenuItem(input: {
  readonly tabs: ReadonlyArray<ChatTabView>;
  /** The tab every chat is in, when they share one. */
  readonly currentKey: string | null;
  readonly inSomeTab: boolean;
  readonly count?: number;
  readonly discord?: boolean;
}): ContextMenuItem<ChatTabMenuId> {
  const noun = input.discord ? "server" : "tab";
  return {
    id: "chat-tab:menu",
    label: input.count === undefined ? `Move to ${noun}` : `Move to ${noun} (${input.count})`,
    icon: "folder",
    children: [
      ...input.tabs.map((tab) => ({
        id: `${MOVE}${tab.key}` as const,
        label: tab.name,
        ...(tab.key === input.currentKey ? { checked: true } : {}),
      })),
      { id: "chat-tab:new", label: `New ${noun}…`, separatorBefore: input.tabs.length > 0 },
      ...(input.inSomeTab
        ? [
            {
              id: "chat-tab:remove" as const,
              label: input.discord ? "Move to Home" : "Remove from tab",
            },
          ]
        : []),
    ],
  };
}

/** The menu on a tab in the strip. */
export function chatTabStripMenuItems(
  tabs: ReadonlyArray<ChatTabView>,
  tab: ChatTabView,
): ReadonlyArray<ContextMenuItem<ChatTabMenuId>> {
  const index = tabs.findIndex((candidate) => candidate.key === tab.key);
  const others = tabs.filter((candidate) => candidate.key !== tab.key);
  return [
    { id: "chat-tab:rename", label: "Rename tab", icon: "pencil" },
    { id: "chat-tab:move-left", label: "Move left", disabled: index <= 0 },
    { id: "chat-tab:move-right", label: "Move right", disabled: index >= tabs.length - 1 },
    ...(others.length > 0
      ? [
          {
            id: "chat-tab:merge" as const,
            label: "Merge into",
            children: others.map((other) => ({
              id: `${MERGE}${other.key}` as const,
              label: other.name,
            })),
          },
        ]
      : []),
    { id: "chat-tab:delete", label: "Delete tab", destructive: true, separatorBefore: true },
  ];
}
