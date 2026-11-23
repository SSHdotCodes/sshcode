import { commandPaletteActionRegistry } from "./CommandPalette.actions";
import type { CommandPaletteActionItem, CommandPaletteSubmenuItem } from "./CommandPalette.logic";

export const RECENT_PALETTE_ACTIONS_KEY = "t3code:command-palette-recents:v1";
const SAVED_ACTION_LIMIT = 12;
const VISIBLE_ACTION_LIMIT = 5;

export function parseRecentPaletteActions(raw: string | null): string[] {
  try {
    const value: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(value)) return [];
    return [
      ...new Set(
        value.filter(
          (id): id is string => typeof id === "string" && id.length > 0 && id.length <= 256,
        ),
      ),
    ].slice(0, SAVED_ACTION_LIMIT);
  } catch {
    return [];
  }
}

export function readRecentPaletteActions(): string[] {
  try {
    return parseRecentPaletteActions(window.localStorage.getItem(RECENT_PALETTE_ACTIONS_KEY));
  } catch {
    return [];
  }
}

export function rememberPaletteAction(
  value: string,
  fallback: ReadonlyArray<string> = [],
): string[] {
  const next = [...new Set([value, ...readRecentPaletteActions(), ...fallback])].slice(
    0,
    SAVED_ACTION_LIMIT,
  );
  try {
    // Save only stable action IDs. Titles, chat text and callbacks stay in memory.
    window.localStorage.setItem(RECENT_PALETTE_ACTIONS_KEY, JSON.stringify(next));
  } catch {
    // A private or full store must never prevent the action from completing.
  }
  return next;
}

export function recentPaletteActionItems(
  items: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>,
  recentValues: ReadonlyArray<string>,
): CommandPaletteActionItem[] {
  const registry = commandPaletteActionRegistry(items);
  return [...new Set(recentValues)]
    .flatMap((value) => {
      const item = registry.get(value);
      return item?.kind === "action" && !item.disabled ? [item] : [];
    })
    .slice(0, VISIBLE_ACTION_LIMIT);
}
