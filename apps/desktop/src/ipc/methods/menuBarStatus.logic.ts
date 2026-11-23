export interface MenuBarChat {
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
}

export interface MenuBarStatus {
  /** Most-needed first. The counts are the full totals; the lists may be shorter. */
  readonly needsYou: ReadonlyArray<MenuBarChat>;
  readonly needsYouCount: number;
  readonly working: ReadonlyArray<MenuBarChat>;
  readonly workingCount: number;
  readonly limits: ReadonlyArray<string>;
}

export type MenuBarEntry =
  | { readonly kind: "header" | "note" | "open-app"; readonly label: string }
  | { readonly kind: "chat"; readonly label: string; readonly chat: MenuBarChat }
  | { readonly kind: "separator" };

/** Chats listed per section before "+N more". */
export const MENU_BAR_ROWS = 8;
const MENU_BAR_LABEL_LENGTH = 60;

function chatLabel(title: string): string {
  const text = title.replace(/\s+/g, " ").trim() || "Untitled chat";
  return text.length > MENU_BAR_LABEL_LENGTH
    ? `${text.slice(0, MENU_BAR_LABEL_LENGTH - 1).trimEnd()}…`
    : text;
}

function pushSection(
  entries: MenuBarEntry[],
  title: string,
  chats: ReadonlyArray<MenuBarChat>,
  count: number,
): void {
  const total = Math.max(count, chats.length);
  if (total === 0) return;
  if (entries.length > 0) entries.push({ kind: "separator" });
  entries.push({ kind: "header", label: title });
  const shown = chats.slice(0, MENU_BAR_ROWS);
  for (const chat of shown) entries.push({ kind: "chat", label: chatLabel(chat.title), chat });
  if (total > shown.length) entries.push({ kind: "note", label: `+${total - shown.length} more` });
}

/** The menu under the menu-bar item, top to bottom. */
export function menuBarEntries(status: MenuBarStatus, appName: string): MenuBarEntry[] {
  const entries: MenuBarEntry[] = [];
  pushSection(entries, "Needs you", status.needsYou, status.needsYouCount);
  pushSection(entries, "Working", status.working, status.workingCount);
  if (entries.length === 0) entries.push({ kind: "note", label: "No chats need you" });
  if (status.limits.length > 0) {
    entries.push({ kind: "separator" }, { kind: "header", label: "Limits" });
    for (const line of status.limits) entries.push({ kind: "note", label: line });
  }
  entries.push({ kind: "separator" }, { kind: "open-app", label: `Open ${appName}` });
  return entries;
}

/** The number beside the icon: chats that need the user, or nothing. */
export function menuBarTitle(status: MenuBarStatus): string {
  const count = Math.max(status.needsYouCount, status.needsYou.length);
  return count > 0 ? String(count) : "";
}

export function menuBarTooltip(status: MenuBarStatus, appName: string): string {
  const needsYou = Math.max(status.needsYouCount, status.needsYou.length);
  const working = Math.max(status.workingCount, status.working.length);
  const parts = [
    ...(needsYou > 0 ? [`${needsYou} ${needsYou === 1 ? "chat needs" : "chats need"} you`] : []),
    ...(working > 0 ? [`${working} working`] : []),
  ];
  return `${appName}: ${parts.length > 0 ? parts.join(", ") : "no chats need you"}`;
}
