import { useEffect, useRef } from "react";
import { DiffFileHeaderSkeleton } from "../DiffPanelShell";

const LOADING_ROW_WIDTHS = ["medium", "short", "long", "medium"] as const;

/** Load the next batch before the reader reaches the end of the current files. */
export function DiffFileLoadingBoundary({ load, count }: { load: () => void; count: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) load();
      },
      { rootMargin: "600px" },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [load]);
  const rows = LOADING_ROW_WIDTHS.slice(0, Math.min(count, LOADING_ROW_WIDTHS.length));
  return (
    <div ref={ref} role="status" aria-label="Loading diff…">
      {rows.map((titleWidth, index) => (
        <div
          key={`${titleWidth}-${index === 3 ? "tail" : "head"}`}
          aria-hidden
          className="border-b border-border/40"
        >
          <DiffFileHeaderSkeleton titleWidth={titleWidth} />
        </div>
      ))}
    </div>
  );
}
