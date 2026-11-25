import type { ComponentProps, ReactNode } from "react";
import { TooltipPopup } from "./ui/tooltip";
import { cn } from "~/lib/utils";
import type { threadMessagePreview } from "./threadMessagePreview";

export function ThreadHoverCardPopup({ className, ...props }: ComponentProps<typeof TooltipPopup>) {
  return (
    <TooltipPopup
      {...props}
      // A card this size moving, fading and resizing between rows read as a glitch.
      still
      variant="glass"
      className={cn("max-w-80 text-left whitespace-normal", className)}
    />
  );
}

/** Shared title, metadata spacing, and optional footer for thread previews. */
export function ThreadHoverCard({
  title,
  children,
  footer,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 max-w-80 flex-col gap-2 px-1 py-2">
      {/* The row already truncates the title; the card is where it reads in full. */}
      <div className="line-clamp-3 min-w-0 text-xs leading-tight font-medium text-foreground wrap-break-word">
        {title}
      </div>
      <div className="grid gap-1.5 pl-0.5 text-xs text-muted-foreground">{children}</div>
      {footer}
    </div>
  );
}

export function ThreadHoverCardLastMessage({
  preview,
}: {
  preview: ReturnType<typeof threadMessagePreview>;
}) {
  if (!preview) return null;
  return (
    <div className="border-t border-border/60 pt-2 text-xs">
      <div className="mb-1 text-2xs font-medium text-muted-foreground">
        {preview.label} · Last message
      </div>
      <p className="line-clamp-2 leading-relaxed text-foreground/80 wrap-break-word">
        {preview.text}
      </p>
    </div>
  );
}
