import { cva, type VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

const listStateVariants = cva("flex min-w-0 flex-col justify-center gap-1", {
  variants: {
    size: {
      default: "min-h-28 px-3 py-5 sm:px-4",
      compact: "min-h-24 px-3 py-4 sm:px-4",
      search: "min-h-40 px-4 py-6",
    },
    align: {
      start: "items-start text-left",
      center: "items-center text-center text-balance",
    },
  },
  defaultVariants: { size: "default", align: "start" },
});

const SKELETON_ROWS = [
  { title: "w-32", description: "w-64", control: "w-14" },
  { title: "w-40", description: "w-52", control: "w-10" },
  { title: "w-28", description: "w-60", control: "w-16" },
] as const;

/** A quiet list status. Pending and empty states share their reserved space. */
export function ListState({
  title,
  description,
  loading = false,
  size,
  align,
  children,
}: VariantProps<typeof listStateVariants> & {
  title: string;
  description?: string;
  loading?: boolean;
  children?: ReactNode;
}) {
  if (loading) {
    const rowCount = size === "compact" ? 2 : 3;
    return (
      <div
        role="status"
        aria-busy="true"
        data-slot="list-state"
        className={cn(
          "motion-safe:animate-skeleton divide-y divide-border/40",
          size === "search" ? "px-4 py-3" : "px-3 py-1 sm:px-4",
        )}
      >
        <span className="sr-only">{description ? `${title} ${description}` : title}</span>
        {SKELETON_ROWS.slice(0, rowCount).map((row) => (
          <div
            key={row.title}
            aria-hidden="true"
            className="flex items-center justify-between gap-6 py-3"
          >
            <div className="min-w-0 flex-1 space-y-2">
              <div
                className={cn("h-3.5 max-w-full rounded-sm bg-muted-foreground/15", row.title)}
              />
              <div
                className={cn("h-3 max-w-full rounded-sm bg-muted-foreground/10", row.description)}
              />
            </div>
            <div className={cn("h-6 shrink-0 rounded-md bg-muted-foreground/12", row.control)} />
          </div>
        ))}
        {/* Actions (e.g. "Open Connections") stay reachable while a slow list loads. */}
        {children ? <div className="py-2">{children}</div> : null}
      </div>
    );
  }

  return (
    <div data-slot="list-state" className={cn(listStateVariants({ size, align }))}>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? (
        <p className="max-w-xl wrap-anywhere text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      ) : null}
      {children ? <div className="mt-2">{children}</div> : null}
    </div>
  );
}
