import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { useSettingsSearchTarget, useSettingsSearchTargetId } from "./settingsLayout";

/** Secondary controls inside a section, opened automatically by a settings search. */
export function SettingsAdvanced({
  id,
  label,
  summary,
  targetIds,
  children,
}: {
  readonly id?: string;
  readonly label: string;
  readonly summary: string;
  readonly targetIds: readonly string[];
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const searchTargetId = useSettingsSearchTargetId();
  const targetRef = useSettingsSearchTarget<HTMLDivElement>(id);
  const lastExpandedTarget = useRef<string | null>(null);
  useEffect(() => {
    if (searchTargetId === null) {
      lastExpandedTarget.current = null;
      return;
    }
    if (
      (searchTargetId !== id && !targetIds.includes(searchTargetId)) ||
      lastExpandedTarget.current === searchTargetId
    )
      return;
    lastExpandedTarget.current = searchTargetId;
    setOpen(true);
  }, [id, searchTargetId, targetIds]);

  return (
    <Collapsible
      id={id}
      ref={targetRef}
      tabIndex={id ? -1 : undefined}
      open={open}
      onOpenChange={setOpen}
    >
      <CollapsibleTrigger
        aria-label={label}
        className="group flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4"
      >
        <ChevronRightIcon
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-data-panel-open:rotate-90 motion-reduce:transition-none"
        />
        <span className="min-w-0 space-y-0.5">
          <span className="block text-sm font-medium">Advanced</span>
          <span className="block text-xs text-muted-foreground">{summary}</span>
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="border-t border-border/50 *:not-first:border-t *:not-first:border-border/50 [&>[data-slot=settings-row]]:rounded-none">
          {children}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
