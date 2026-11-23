import type { DesktopMenuBarStatus } from "@t3tools/contracts";

/** Chats sent per section; the desktop menu lists fewer and counts the rest. */
export const MENU_BAR_MAX_CHATS = 12;
export const MENU_BAR_MAX_LIMITS = 6;

export interface MenuBarChatInput {
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
  readonly needsYou: boolean;
}

export interface MenuBarLimitInput {
  readonly accountLabel: string;
  readonly label: string;
  readonly usedPercent: number;
  /** A formatted reset time, or null when the provider reports none. */
  readonly resets: string | null;
}

/** What the Mac menu-bar item shows. Chats and limits keep the order they arrive in. */
export function buildMenuBarStatus(input: {
  readonly chats: ReadonlyArray<MenuBarChatInput>;
  readonly limits: ReadonlyArray<MenuBarLimitInput>;
  /** Screen-recording privacy: chat titles stay out of the menu bar. */
  readonly hideTitles: boolean;
}): DesktopMenuBarStatus {
  const needsYou = input.chats.filter((chat) => chat.needsYou);
  const working = input.chats.filter((chat) => !chat.needsYou);
  const present = (chat: MenuBarChatInput) => ({
    environmentId: chat.environmentId,
    threadId: chat.threadId,
    title: input.hideTitles ? "Chat" : chat.title.replace(/\s+/g, " ").trim().slice(0, 200),
  });
  return {
    needsYou: needsYou.slice(0, MENU_BAR_MAX_CHATS).map(present),
    needsYouCount: needsYou.length,
    working: working.slice(0, MENU_BAR_MAX_CHATS).map(present),
    workingCount: working.length,
    limits: input.limits.slice(0, MENU_BAR_MAX_LIMITS).map((limit) => {
      const used = `${limit.accountLabel} · ${limit.label}: ${Math.round(limit.usedPercent)}% used`;
      return limit.resets === null ? used : `${used}, resets ${limit.resets}`;
    }),
  };
}
