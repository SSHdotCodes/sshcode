import {
  ChatWidth,
  type ClientSettings,
  type ClientSettingsPatch,
} from "@t3tools/contracts/settings";
import type { ReactNode } from "react";
import type { CommandPaletteActionItem, CommandPaletteSubmenuItem } from "./CommandPalette.logic";
import {
  SETTINGS_SEARCH_ITEMS,
  SETTINGS_SECTION_LABELS,
  type SettingsPath,
  type SettingsSearchItem,
} from "./settings/settingsSearch";

export function buildSettingsSectionActions(input: {
  readonly availableItems: ReadonlyArray<SettingsSearchItem>;
  readonly icon: ReactNode;
  readonly navigate: (to: SettingsPath) => Promise<void>;
}): CommandPaletteActionItem[] {
  const availablePaths = new Set(input.availableItems.map((item) => item.to));
  return Object.entries(SETTINGS_SECTION_LABELS).flatMap(([to, label]) => {
    const path = to as SettingsPath;
    return availablePaths.has(path)
      ? [
          {
            kind: "action" as const,
            value: `settings-section:${path}`,
            title: `${label} settings`,
            searchTerms: [`${label} settings`, "preferences", "open", "go to"],
            icon: input.icon,
            run: () => input.navigate(path),
          },
        ]
      : [];
  });
}

export function buildLayoutActions(input: {
  readonly settings: Pick<ClientSettings, "chatWidth" | "redesignEnabled">;
  readonly icon: ReactNode;
  readonly updateSettings: (patch: ClientSettingsPatch) => Promise<unknown>;
  readonly searchItems?: ReadonlyArray<SettingsSearchItem>;
}): Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> {
  const searchItems: ReadonlyArray<SettingsSearchItem> = input.searchItems ?? SETTINGS_SEARCH_ITEMS;
  const design = searchItems.find((item) => item.id === "new-design");
  const width = searchItems.find((item) => item.id === "chat-width");
  const actions: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [];
  if (design) {
    actions.push({
      kind: "action",
      value: "action:toggle-new-design",
      title: `${input.settings.redesignEnabled ? "Turn off" : "Turn on"} ${design.title.toLowerCase()}`,
      searchTerms: [design.title, ...(design.searchTerms ?? []), "toggle", "layout"],
      icon: input.icon,
      run: async () => {
        await input.updateSettings({ redesignEnabled: !input.settings.redesignEnabled });
      },
    });
  }
  if (width) {
    actions.push({
      kind: "submenu",
      value: "action:chat-width",
      title: `Change ${width.title.toLowerCase()}`,
      description:
        input.settings.chatWidth.slice(0, 1).toUpperCase() + input.settings.chatWidth.slice(1),
      searchTerms: [width.title, ...(width.searchTerms ?? [])],
      icon: input.icon,
      addonIcon: input.icon,
      searchChildren: true,
      groups: [
        {
          value: "chat-width",
          label: width.title,
          items: ChatWidth.literals.map((value) => ({
            kind: "action" as const,
            value: `chat-width:${value}`,
            title: `${width.title}: ${value.slice(0, 1).toUpperCase()}${value.slice(1)}`,
            description: input.settings.chatWidth === value ? "Current" : undefined,
            searchTerms: [`${width.title} ${value}`, value, "layout", "messages", "composer"],
            icon: input.icon,
            run: async () => {
              await input.updateSettings({ chatWidth: value });
            },
          })),
        },
      ],
    });
  }
  return actions;
}

/** Only opt-in submenus expose their children to root search and action history. */
export function commandPaletteActionRegistry(
  items: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>,
) {
  const registry = new Map<string, CommandPaletteActionItem | CommandPaletteSubmenuItem>();
  for (const item of items) {
    registry.set(item.value, item);
    if (item.kind === "submenu" && item.searchChildren) {
      for (const group of item.groups) {
        for (const child of group.items) registry.set(child.value, child);
      }
    }
  }
  return registry;
}
