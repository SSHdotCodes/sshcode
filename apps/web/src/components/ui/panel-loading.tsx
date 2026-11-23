import { Skeleton } from "./skeleton";

/** Paints immediately while a file or diff module loads, with the same toolbar geometry. */
export function PanelLoading({
  label,
  variant = "code",
  toolbar = true,
}: {
  label: string;
  variant?: "code" | "list";
  toolbar?: boolean;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      data-slot="panel-loading"
      className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background"
    >
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {toolbar ? (
          <div className="flex h-10 shrink-0 items-center justify-between gap-4 border-b border-border/60 px-3">
            <Skeleton className="h-3 w-24" shape="pill" />
            <div className="flex gap-2">
              <Skeleton className="size-4" />
              <Skeleton className="size-4" />
            </div>
          </div>
        ) : null}
        <div className="space-y-2 px-3 py-4">
          {["w-3/5", "w-4/5", "w-2/5", "w-3/4", "w-1/2", "w-2/3"].map((width, index) => (
            <div className="flex h-5 items-center gap-3" key={width}>
              {variant === "list" ? (
                <Skeleton className="size-3.5 shrink-0" />
              ) : (
                <Skeleton className="h-2.5 w-4 shrink-0" shape="pill" />
              )}
              <div className={variant === "list" ? "w-3/4" : "w-full"}>
                <Skeleton className={`h-2.5 ${width}`} shape="pill" />
              </div>
              {index === 0 && variant === "code" ? (
                <Skeleton className="h-2.5 w-8 shrink-0" shape="pill" />
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
