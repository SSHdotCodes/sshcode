import { usePrivacyLabel, usePrivacyMode } from "~/hooks/usePrivacyMode";
import { ALL_CHATS_TAB, type ChatTabView } from "@t3tools/client-runtime/state/chat-tabs";
import { CHAT_TAB_NAME_MAX_LENGTH, CLAUDE_RC_TAB } from "@t3tools/contracts";
import { type Ref, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";

const DROP_ATTRIBUTE = "data-chat-tab-drop";

/** The tab under `point` while a chat is dragged over the strip: its key, "" for All. */
export function chatTabDropAt(
  strip: HTMLElement | null,
  point: { readonly x: number; readonly y: number },
): string | null {
  if (strip === null) return null;
  for (const element of strip.querySelectorAll<HTMLElement>(`[${DROP_ATTRIBUTE}]`)) {
    const rect = element.getBoundingClientRect();
    if (
      point.x >= rect.left &&
      point.x <= rect.right &&
      point.y >= rect.top &&
      point.y <= rect.bottom
    ) {
      return element.getAttribute(DROP_ATTRIBUTE);
    }
  }
  return null;
}

function chatTabStripKeys(tabs: ReadonlyArray<ChatTabView>): readonly string[] {
  return [ALL_CHATS_TAB, ...tabs.map((tab) => tab.key), CLAUDE_RC_TAB];
}

/**
 * Browser-style tabs above the chat list: All, then each tab of related chats, then
 * Terminal. A dot on a tab you are not in says a chat there needs you (amber) or is
 * working (blue). All and Terminal stay even when there are no named tabs. Terminal
 * is not a place to drop a chat.
 */
export function SidebarChatTabs({
  ref,
  tabs,
  selected,
  dropTarget,
  renaming,
  onSelect,
  onContextMenu,
  onRename,
  onRenameEnd,
}: {
  readonly ref: Ref<HTMLDivElement>;
  readonly tabs: ReadonlyArray<ChatTabView>;
  readonly selected: string;
  readonly dropTarget: string | null;
  readonly renaming: string | null;
  readonly onSelect: (key: string) => void;
  readonly onContextMenu: (tab: ChatTabView, position: { x: number; y: number }) => void;
  readonly onRename: (tab: ChatTabView, name: string) => void;
  readonly onRenameEnd: () => void;
}) {
  const privateLabel = usePrivacyLabel();
  const privacy = usePrivacyMode();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  // Fade an edge where more tabs are scrolled out of view.
  const measure = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const start = scroller.scrollLeft > 1;
    const end = scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1;
    setEdges((current) =>
      current.start === start && current.end === end ? current : { start, end },
    );
  }, []);
  useLayoutEffect(measure, [measure, tabs, renaming]);
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    return observeResize(scroller, measure);
  }, [measure, tabs]);

  // Keep the open tab in view, as a browser does.
  useEffect(() => {
    scrollerRef.current
      ?.querySelector<HTMLElement>(`[data-chat-tab-key="${CSS.escape(selected)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);

  // Ctrl+Tab and Ctrl+Shift+Tab step through the tabs, wrapping around.
  useEffect(() => {
    const keys = chatTabStripKeys(tabs);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Tab" || !event.ctrlKey) return;
      if (event.metaKey || event.altKey) return;
      event.preventDefault();
      const index = Math.max(0, keys.indexOf(selected));
      const next = keys[(index + (event.shiftKey ? keys.length - 1 : 1)) % keys.length];
      if (next !== undefined) onSelect(next);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onSelect, selected, tabs]);

  const keys = chatTabStripKeys(tabs);
  return (
    <TooltipProvider delay={500} closeDelay={0}>
      <div
        ref={ref}
        role="tablist"
        aria-label="Chat tabs"
        onKeyDown={(event) => {
          if (!(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "tab")
            return;
          const current = event.target.getAttribute("data-chat-tab-key");
          const index = keys.indexOf(current ?? "");
          let next = index;
          if (event.key === "ArrowRight") next = (index + 1) % keys.length;
          else if (event.key === "ArrowLeft") next = (index + keys.length - 1) % keys.length;
          else if (event.key === "Home") next = 0;
          else if (event.key === "End") next = keys.length - 1;
          else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            const tab = tabs.find((candidate) => candidate.key === current);
            if (tab) {
              event.preventDefault();
              const rect = event.target.getBoundingClientRect();
              onContextMenu(tab, { x: rect.left, y: rect.bottom });
            }
            return;
          } else return;
          event.preventDefault();
          const key = keys[next];
          if (key === undefined) return;
          onSelect(key);
          event.currentTarget
            .querySelector<HTMLElement>(`[data-chat-tab-key="${CSS.escape(key)}"]`)
            ?.focus();
        }}
        className="relative -mx-0.5 mt-1 flex items-center gap-0.5 px-0.5"
      >
        {/* All stays put, like a pinned browser tab, while the named tabs scroll. */}
        <ChatTabButton
          tabKey={ALL_CHATS_TAB}
          label="All"
          selected={selected === ALL_CHATS_TAB}
          dropTarget={dropTarget === ALL_CHATS_TAB}
          onSelect={onSelect}
        />
        <div
          ref={scrollerRef}
          onScroll={measure}
          onWheel={(event) => {
            // A plain wheel scrolls the strip sideways.
            if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
            event.currentTarget.scrollLeft += event.deltaY;
          }}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            edges.start &&
              edges.end &&
              "[mask-image:linear-gradient(to_right,transparent,black_16px,black_calc(100%-16px),transparent)]",
            edges.start &&
              !edges.end &&
              "[mask-image:linear-gradient(to_right,transparent,black_16px)]",
            !edges.start &&
              edges.end &&
              "[mask-image:linear-gradient(to_right,black_calc(100%-16px),transparent)]",
          )}
        >
          {tabs.map((tab) =>
            !privacy && renaming === tab.key ? (
              <ChatTabRenameInput
                key={tab.key}
                tab={tab}
                onRename={onRename}
                onDone={onRenameEnd}
              />
            ) : (
              <ChatTabButton
                key={tab.key}
                tabKey={tab.key}
                label={privateLabel("Tab", tab.key, tab.name)}
                tooltip={`${privateLabel("Tab", tab.key, tab.name)} · ${tab.threadKeys.size} ${tab.threadKeys.size === 1 ? "chat" : "chats"}`}
                selected={selected === tab.key}
                dropTarget={dropTarget === tab.key}
                status={tab.attention ? "attention" : tab.working ? "working" : null}
                onSelect={onSelect}
                onContextMenu={(position) => onContextMenu(tab, position)}
              />
            ),
          )}
          <ChatTabButton
            tabKey={CLAUDE_RC_TAB}
            label="Terminal"
            selected={selected === CLAUDE_RC_TAB}
            dropTarget={false}
            onSelect={onSelect}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}

function ChatTabButton(props: {
  readonly tabKey: string;
  readonly label: string;
  readonly tooltip?: string;
  readonly selected: boolean;
  readonly dropTarget: boolean;
  readonly status?: "attention" | "working" | null;
  readonly onSelect: (key: string) => void;
  readonly onContextMenu?: (position: { x: number; y: number }) => void;
}) {
  const { onContextMenu } = props;
  const button = (
    <button
      type="button"
      role="tab"
      aria-selected={props.selected}
      tabIndex={props.selected ? 0 : -1}
      data-chat-tab-key={props.tabKey}
      {...(props.tabKey === CLAUDE_RC_TAB ? {} : { [DROP_ATTRIBUTE]: props.tabKey })}
      onClick={() => props.onSelect(props.tabKey)}
      onContextMenu={
        onContextMenu
          ? (event) => {
              event.preventDefault();
              onContextMenu({ x: event.clientX, y: event.clientY });
            }
          : undefined
      }
      className={cn(
        "relative inline-flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        props.selected
          ? "bg-sidebar-row-selected text-sidebar-foreground"
          : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        props.dropTarget &&
          "bg-primary/10 text-sidebar-foreground ring-1 ring-inset ring-primary/50",
      )}
    >
      <span className="max-w-32 truncate">{props.label}</span>
      {props.status && !props.selected ? (
        <span
          role="img"
          aria-label={props.status === "attention" ? "A chat needs you" : "A chat is working"}
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            props.status === "attention" ? "bg-warning-foreground" : "bg-info-foreground",
          )}
        />
      ) : null}
    </button>
  );
  if (props.tooltip === undefined) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup side="bottom">{props.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

function ChatTabRenameInput(props: {
  readonly tab: ChatTabView;
  readonly onRename: (tab: ChatTabView, name: string) => void;
  readonly onDone: () => void;
}) {
  const [value, setValue] = useState(props.tab.name);
  const [finished, setFinished] = useState(false);
  const finish = (save: boolean) => {
    if (finished) return;
    setFinished(true);
    const name = value.trim();
    if (save && name.length > 0 && name !== props.tab.name) props.onRename(props.tab, name);
    props.onDone();
  };
  return (
    <input
      autoFocus
      aria-label="Tab name"
      value={value}
      maxLength={CHAT_TAB_NAME_MAX_LENGTH}
      size={Math.max(6, value.length + 1)}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.currentTarget.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(true);
        else if (event.key === "Escape") finish(false);
      }}
      className="h-6 shrink-0 rounded-md border border-input bg-card px-2 text-xs font-medium text-card-foreground outline-none focus:border-foreground"
    />
  );
}
