import {
  createContext,
  use,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { MarkdownFindContext, useFindRevealRef } from "./markdownFindContext";
import { toolOutputPreview } from "./MessagesTimeline.logic";
import { usePersistentDisclosure } from "./usePersistentDisclosure";

export const ToolOutputDisclosureContext = createContext<{
  readonly itemId: string;
  readonly expandedEntries: Set<string>;
  readonly onToggle: ((collapsed: boolean) => void) | undefined;
} | null>(null);

/** Keep large settled results cheap to render; live command output keeps following its tail. */
export function ToolOutputText({
  text,
  className,
  running = false,
  renderText,
}: {
  text: string;
  className?: string;
  running?: boolean;
  renderText?: (text: string) => ReactNode;
}) {
  const disclosure = use(ToolOutputDisclosureContext);
  const expansionKey = disclosure ? `tool-output:${disclosure.itemId}` : null;
  const [expanded, updateExpanded] = usePersistentDisclosure(
    disclosure?.expandedEntries,
    expansionKey,
  );
  const findActive = use(MarkdownFindContext);
  const id = useId();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const preview = useMemo(() => toolOutputPreview(text), [text]);
  const collapsed = !running && !expanded && preview !== text;
  const visibleText = collapsed && !findActive ? preview : text;
  const reveal = useCallback(() => updateExpanded(true), [updateExpanded]);
  const revealRef = useFindRevealRef(reveal);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (running && element && followRef.current) element.scrollTop = element.scrollHeight;
  });

  return (
    <div>
      <div
        id={id}
        ref={(element) => {
          scrollRef.current = element;
          return revealRef(element);
        }}
        data-thread-find-fold={collapsed ? "" : undefined}
        className={cn(
          "max-h-80 overflow-auto whitespace-pre-wrap break-words text-muted-foreground",
          collapsed && findActive && "max-h-48 overflow-hidden",
          className,
        )}
        onScroll={(event) => {
          const element = event.currentTarget;
          followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 8;
        }}
      >
        {renderText ? renderText(visibleText) : visibleText}
      </div>
      {!running && preview !== text ? (
        <div className="mt-1" data-thread-find-ignore>
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-controls={id}
            aria-expanded={!collapsed}
            data-scroll-anchor-ignore
            onClick={(event) => {
              event.stopPropagation();
              disclosure?.onToggle?.(!collapsed);
              updateExpanded(collapsed);
            }}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {collapsed ? "Show more" : "Show less"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
