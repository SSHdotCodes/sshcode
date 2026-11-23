import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { KeyboardIcon, SettingsIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { isElectron } from "../env";
import { formatShortcutLabel } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import { CommandPaletteContent } from "./CommandPaletteContent";
import { CommandPaletteResults } from "./CommandPaletteResults";
import type { CommandPaletteGroup } from "./CommandPalette.logic";
import { buildKeyboardShortcutGroups } from "./KeyboardShortcuts.logic";
import { keybindingSearchAnchorId } from "./settings/settingsSearch";
import { shortcutKeycaps } from "./settings/KeybindingsSettings.logic";
import { CommandFooterAction } from "./ui/command";
import { Kbd, KbdGroup } from "./ui/kbd";

export function KeyboardShortcuts(props: { readonly setOpen: (open: boolean) => void }) {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const navigate = useNavigate();
  const groups = useMemo(
    () =>
      buildKeyboardShortcutGroups({
        keybindings,
        query,
        platform: navigator.platform,
        isDesktop: isElectron,
      }),
    [keybindings, query],
  );
  const openSettings = (command?: Parameters<typeof keybindingSearchAnchorId>[0]) => {
    props.setOpen(false);
    void navigate({
      to: "/settings/keybindings",
      ...(command ? { hash: keybindingSearchAnchorId(command) } : {}),
      hashScrollIntoView: false,
    });
  };
  const resultGroups: CommandPaletteGroup[] = groups.map((group) => ({
    value: group.label,
    label: group.label,
    items: group.rows.map((row) => ({
      kind: "action",
      value: row.id,
      title: row.label,
      description: row.when ? `When: ${row.when}` : undefined,
      searchTerms: [],
      icon: null,
      titleTrailingContent: (
        <KbdGroup aria-label={formatShortcutLabel(row.shortcut)}>
          {shortcutKeycaps(row.shortcut, navigator.platform).map((key) => (
            <Kbd key={key}>{key}</Kbd>
          ))}
        </KbdGroup>
      ),
      run: async () => openSettings(row.command),
    })),
  }));
  return (
    <CommandPaletteContent
      aria-label="Keyboard shortcuts"
      mode="none"
      value={query}
      onValueChange={(value) => {
        setHighlighted(null);
        setQuery(value);
      }}
      autoHighlight="always"
      footerActionLabel="Customize"
      onItemHighlighted={(value) => setHighlighted(typeof value === "string" ? value : null)}
      inputProps={{ placeholder: "Search keyboard shortcuts...", startAddon: <KeyboardIcon /> }}
      escapeLabel="Back"
      footerTrailing={
        <CommandFooterAction onClick={() => openSettings()}>
          <SettingsIcon />
          Customize shortcuts
        </CommandFooterAction>
      }
    >
      <div className="px-4 pt-3 pb-1 text-xs text-muted-foreground">
        Your current bindings. Select a shortcut to customize it.
      </div>
      <CommandPaletteResults
        groups={resultGroups}
        highlightedItemValue={highlighted}
        keybindings={keybindings}
        isActionsOnly
        emptyStateMessage="No matching shortcuts."
        onExecuteItem={(item) => {
          if (item.kind === "action") void item.run();
        }}
      />
    </CommandPaletteContent>
  );
}
