import { useAtomValue } from "@effect/atom-react";
import { MessageSquareTextIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { primaryServerKeybindingsAtom } from "~/state/server";
import type { CommandPaletteActionItem } from "../CommandPalette.logic";
import { CommandPaletteContent } from "../CommandPaletteContent";
import { CommandPaletteResults } from "../CommandPaletteResults";
import { CommandDialog, CommandDialogPopup } from "../ui/command";
import { matchEarlierPrompts, type ComposerPromptHistoryEntry } from "./composerPromptHistory";

/**
 * A searchable list of the prompts already sent in this chat. Picking one puts it in the
 * composer to edit and send again: the pointer's way to what ArrowUp does on an empty composer.
 */
export function ComposerPromptHistoryDialog(props: {
  /** Oldest first, as the composer's prompt history builds them. */
  readonly entries: ReadonlyArray<ComposerPromptHistoryEntry>;
  readonly onClose: () => void;
  readonly onSelect: (prompt: string) => void;
}) {
  const { entries, onClose, onSelect } = props;
  const [query, setQuery] = useState("");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const items = useMemo<CommandPaletteActionItem[]>(
    () =>
      matchEarlierPrompts(entries, query).map((entry) => ({
        kind: "action",
        value: `earlier-prompt:${entry.id}`,
        searchTerms: [entry.prompt],
        title: entry.preview,
        icon: <MessageSquareTextIcon className="size-4 text-icon-muted" />,
        run: async () => onSelect(entry.prompt),
      })),
    [entries, onSelect, query],
  );

  return (
    <CommandDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <CommandDialogPopup
        aria-label="Earlier prompts"
        className="overflow-hidden"
        onBackdropPointerDown={onClose}
      >
        <CommandPaletteContent
          aria-label="Earlier prompts"
          autoHighlight="always"
          escapeLabel="Close"
          footerActionLabel="Use prompt"
          inputProps={{ placeholder: "Search earlier prompts…" }}
          mode="none"
          onItemHighlighted={(value) => {
            setHighlightedItemValue(typeof value === "string" ? value : null);
          }}
          onValueChange={(value) => {
            setHighlightedItemValue(null);
            setQuery(value);
          }}
          panelSize="tall-list"
          testId="composer-prompt-history"
          value={query}
        >
          <CommandPaletteResults
            groups={
              items.length > 0 ? [{ value: "earlier-prompts", label: "This chat", items }] : []
            }
            highlightedItemValue={highlightedItemValue}
            isActionsOnly={false}
            keybindings={keybindings}
            onExecuteItem={(item) => {
              if (item.kind !== "action") return;
              onClose();
              void item.run();
            }}
            emptyStateMessage={
              query.trim() ? "No earlier prompt matches." : "No earlier prompts in this chat."
            }
          />
        </CommandPaletteContent>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
