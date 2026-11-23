import { cva, type VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Skeleton } from "./skeleton";

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
  return (
    <div
      role={loading ? "status" : undefined}
      aria-busy={loading || undefined}
      data-slot="list-state"
      className={cn(listStateVariants({ size, align }))}
    >
      <p className="text-sm font-medium text-foreground">{title}</p>
      {loading ? (
        <>
          <div aria-hidden="true" className="flex h-5 max-w-full items-center">
            <Skeleton className="h-3 w-48 max-w-full" shape="pill" />
          </div>
          {description ? <span className="sr-only">{description}</span> : null}
        </>
      ) : description ? (
        <p className="max-w-xl wrap-anywhere text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      ) : null}
      {children ? <div className="mt-2">{children}</div> : null}
    </div>
  );
}
