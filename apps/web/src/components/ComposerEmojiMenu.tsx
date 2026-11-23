import type { Editor } from "@tiptap/react";
import { detectComposerEmojiTrigger } from "@t3tools/shared/composerTrigger";
import {
  emojiName,
  loadEmojiData,
  searchEmoji,
  type EmojiData,
  type EmojiEntry,
} from "@t3tools/shared/emoji";
import { SmileIcon } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { cn } from "~/lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { readEmojiRecents, rememberEmoji } from "./composerEmojiRecents";

type EmojiTrigger = { from: number; to: number; query: string; key: string };

/**
 * The editable element, read only when a popover asks for it: the composer's
 * editor mounts its view when it first commits, so render must not read it.
 */
function editorRoot(editor: Editor | null) {
  return editor?.view.dom ?? null;
}

function readTrigger(editor: Editor): EmojiTrigger | null {
  const { selection, doc } = editor.state;
  if (
    !editor.isFocused ||
    !selection.empty ||
    editor.isActive("code") ||
    selection.$from.parent.type.spec.code
  )
    return null;
  const { parent, parentOffset } = selection.$from;
  const tail = parent.textBetween(Math.max(0, parentOffset - 66), parentOffset, "", "\uFFFC");
  if (!/:[a-z0-9_+-]{1,64}$/i.test(tail)) return null;
  const prefix = doc.textBetween(0, selection.from, "\n", "\uFFFC");
  const trigger = detectComposerEmojiTrigger(prefix, prefix.length);
  if (!trigger) return null;
  const from = selection.from - (trigger.rangeEnd - trigger.rangeStart);
  return {
    from,
    to: selection.from,
    query: trigger.query,
    key: `${from}:${selection.from}:${trigger.query}`,
  };
}

/** Emoji suggestions yield every unrelated key to the composer's command menus. */
export function ComposerEmojiMenu({
  editor,
  disabled,
  onKeyHandlerChange,
}: {
  editor: Editor | null;
  disabled: boolean;
  onKeyHandlerChange: (handler: ((event: KeyboardEvent) => boolean) | null) => void;
}) {
  const id = useId();
  const [data, setData] = useState<EmojiData | null>(null);
  const [trigger, setTrigger] = useState<EmojiTrigger | null>(null);
  const [dismissed, setDismissed] = useState<{ from: number; doc: Editor["state"]["doc"] } | null>(
    null,
  );
  const [highlight, setHighlight] = useState({ key: "", index: 0 });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState<string[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const pickerSelection = useRef<{ from: number; to: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const autocompleteOpen =
    !disabled &&
    !pickerOpen &&
    trigger !== null &&
    !(trigger.from === dismissed?.from && editor?.state.doc === dismissed?.doc);
  const suggestions = useMemo(
    () => (data && trigger ? searchEmoji(data, trigger.query, 8) : []),
    [data, trigger],
  );
  const matches = useMemo(
    () => (data && pickerOpen ? searchEmoji(data, query, 48) : []),
    [data, pickerOpen, query],
  );
  const recentEntries = useMemo(
    () =>
      data && pickerOpen
        ? recents
            .flatMap((name) => {
              const entry = data.find((entry) => emojiName(entry) === name);
              return entry ? [entry] : [];
            })
            .slice(0, 8)
        : [],
    [data, pickerOpen, recents],
  );
  const pickerEntries = query.trim()
    ? matches
    : [...recentEntries, ...matches.filter((entry) => !recentEntries.includes(entry))];
  const entries = pickerOpen ? pickerEntries : suggestions;
  const menuKey = pickerOpen ? `picker:${query}` : (trigger?.key ?? "");
  const selectedIndex =
    highlight.key === menuKey ? Math.min(highlight.index, Math.max(0, entries.length - 1)) : 0;
  const setActiveIndex = (index: number) => setHighlight({ key: menuKey, index });

  useEffect(() => {
    if (!editor || disabled) return;
    const update = () => {
      const next = readTrigger(editor);
      setTrigger((previous) => {
        if (previous?.key === next?.key) return previous;
        return next;
      });
    };
    editor.on("transaction", update);
    editor.on("focus", update);
    update();
    return () => {
      editor.off("transaction", update);
      editor.off("focus", update);
    };
  }, [disabled, editor]);
  useEffect(() => {
    if (!(autocompleteOpen || pickerOpen) || data) return;
    let active = true;
    loadEmojiData()
      .then((next) => {
        if (active) {
          setData(next);
          setLoadFailed(false);
        }
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [autocompleteOpen, data, pickerOpen]);

  const insert = (entry: EmojiEntry) => {
    if (!editor || disabled) return;
    const range = pickerOpen ? pickerSelection.current : trigger;
    if (!range) return;
    setRecents(rememberEmoji(emojiName(entry)));
    setPickerOpen(false);
    setTrigger(null);
    editor
      .chain()
      .focus()
      .insertContentAt({ from: range.from, to: range.to }, { type: "text", text: entry[0] })
      .run();
  };
  const onMenuKey = (event: KeyboardEvent | ReactKeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      ("isComposing" in event && event.isComposing) ||
      ("nativeEvent" in event && event.nativeEvent.isComposing)
    )
      return false;
    if (event.key === "Escape") {
      if (trigger && editor) setDismissed({ from: trigger.from, doc: editor.state.doc });
      setPickerOpen(false);
      return true;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!entries.length) return false;
      const step = event.key === "ArrowUp" ? -1 : 1;
      setActiveIndex((selectedIndex + step + entries.length) % entries.length);
      return true;
    }
    if ((event.key === "Enter" || event.key === "Tab") && entries[selectedIndex]) {
      insert(entries[selectedIndex]!);
      return true;
    }
    return false;
  };
  useLayoutEffect(() => {
    onKeyHandlerChange((event) => (autocompleteOpen ? onMenuKey(event) : false));
    return () => {
      onKeyHandlerChange(null);
    };
  });
  useEffect(() => {
    document.getElementById(`${id}-${selectedIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [id, selectedIndex]);
  useEffect(() => {
    if (!editor || !autocompleteOpen) return;
    const element = editor.view.dom;
    element.setAttribute("aria-controls", id);
    element.setAttribute("aria-autocomplete", "list");
    element.setAttribute("aria-expanded", "true");
    if (suggestions.length) element.setAttribute("aria-activedescendant", `${id}-${selectedIndex}`);
    return () => {
      element.removeAttribute("aria-controls");
      element.removeAttribute("aria-activedescendant");
      element.removeAttribute("aria-expanded");
    };
  }, [autocompleteOpen, editor, id, selectedIndex, suggestions.length]);

  const grid = (items: EmojiEntry[], offset: number) => (
    <div className="grid grid-cols-8 gap-0.5">
      {items.map((entry, index) => (
        <button
          type="button"
          key={emojiName(entry)}
          id={`${id}-${offset + index}`}
          role="option"
          aria-label={`:${emojiName(entry)}:`}
          aria-selected={selectedIndex === offset + index}
          className={cn(
            "flex size-8 items-center justify-center rounded-md text-xl hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring",
            selectedIndex === offset + index && "bg-accent",
          )}
          tabIndex={-1}
          onMouseDown={(event) => event.preventDefault()}
          onMouseMove={() => setActiveIndex(offset + index)}
          onClick={() => insert(entry)}
        >
          {entry[0]}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <div className="absolute end-0 top-0">
        <Popover
          open={pickerOpen && !disabled}
          onOpenChange={(open) => {
            if (open && editor) {
              pickerSelection.current = {
                from: editor.state.selection.from,
                to: editor.state.selection.to,
              };
              setQuery("");
              setActiveIndex(0);
              setRecents(readEmojiRecents());
              if (trigger && editor) setDismissed({ from: trigger.from, doc: editor.state.doc });
            }
            setPickerOpen(open);
          }}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <PopoverTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      disabled={disabled}
                      aria-label="Choose emoji"
                    />
                  }
                />
              }
            >
              <SmileIcon aria-hidden="true" className="size-4" />
            </TooltipTrigger>
            <TooltipPopup>Choose emoji</TooltipPopup>
          </Tooltip>
          <PopoverPopup
            side="top"
            align="end"
            width="sm"
            padding="compact"
            aria-label="Emoji picker"
            finalFocus={() => editorRoot(editor) ?? false}
          >
            <div
              className="space-y-2"
              onKeyDown={(event) => {
                if (onMenuKey(event)) {
                  event.preventDefault();
                  event.stopPropagation();
                }
              }}
            >
              <Input
                type="search"
                size="sm"
                aria-label="Search emoji"
                placeholder="Search emoji…"
                value={query}
                onValueChange={(value) => {
                  setQuery(value);
                  setActiveIndex(0);
                }}
                role="combobox"
                aria-expanded="true"
                aria-controls={id}
                aria-activedescendant={entries.length ? `${id}-${selectedIndex}` : undefined}
              />
              <div
                ref={pickerOpen ? listRef : undefined}
                id={id}
                role="listbox"
                aria-label="Emoji"
                className="max-h-64 space-y-2 overflow-y-auto"
              >
                {!query.trim() && recentEntries.length > 0 ? (
                  <div role="group" aria-label="Recent" className="space-y-2">
                    <p aria-hidden="true" className="text-xs text-muted-foreground">
                      Recent
                    </p>
                    {grid(recentEntries, 0)}
                  </div>
                ) : null}
                <div
                  role="group"
                  aria-label={query.trim() ? "Search results" : "Popular"}
                  className="space-y-2"
                >
                  {!query.trim() ? (
                    <p aria-hidden="true" className="text-xs text-muted-foreground">
                      Popular
                    </p>
                  ) : null}
                  {grid(
                    pickerEntries.slice(query.trim() ? 0 : recentEntries.length),
                    query.trim() ? 0 : recentEntries.length,
                  )}
                </div>
              </div>
              {entries.length === 0 ? (
                <p role="status" className="py-4 text-center text-xs text-muted-foreground">
                  {data
                    ? "No emoji found."
                    : loadFailed
                      ? "Emoji could not load. Try reopening the picker."
                      : "Loading emoji…"}
                </p>
              ) : null}
              <p className="truncate text-xs text-muted-foreground">
                {entries[selectedIndex]
                  ? `:${emojiName(entries[selectedIndex]!)}:`
                  : "Search by name or keyword"}
              </p>
            </div>
          </PopoverPopup>
        </Popover>
      </div>
      <Popover
        open={autocompleteOpen}
        onOpenChange={(open) => {
          if (!open && trigger && editor)
            setDismissed({ from: trigger.from, doc: editor.state.doc });
        }}
      >
        <PopoverPopup
          anchor={() => editorRoot(editor)}
          side="top"
          align="start"
          width="sm"
          padding="compact"
          initialFocus={false}
          finalFocus={false}
          aria-label="Emoji suggestions"
        >
          <div
            ref={!pickerOpen ? listRef : undefined}
            id={id}
            role="listbox"
            aria-label="Emoji suggestions"
            className="max-h-64 overflow-y-auto"
          >
            {suggestions.map((entry, index) => (
              <button
                key={emojiName(entry)}
                type="button"
                id={`${id}-${index}`}
                role="option"
                aria-selected={selectedIndex === index}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent",
                  selectedIndex === index && "bg-accent",
                )}
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setActiveIndex(index)}
                onClick={() => insert(entry)}
              >
                <span aria-hidden="true" className="text-xl">
                  {entry[0]}
                </span>
                <span className="truncate">:{emojiName(entry)}:</span>
              </button>
            ))}
          </div>
          {suggestions.length === 0 ? (
            <p role="status" className="px-2 py-3 text-xs text-muted-foreground">
              {data ? "No matching emoji" : loadFailed ? "Emoji could not load" : "Loading emoji…"}
            </p>
          ) : null}
          <p className="mt-1 border-t border-border pt-2 text-xs text-muted-foreground">
            ↑↓ to browse · enter or tab to insert
          </p>
        </PopoverPopup>
      </Popover>
    </>
  );
}
