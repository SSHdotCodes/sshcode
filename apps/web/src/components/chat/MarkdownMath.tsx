import { lazy, memo, Suspense } from "react";
import { RenderErrorBoundary } from "../RenderErrorBoundary";

const MathTypeset = lazy(() => import("./MathTypeset"));

export const MarkdownMath = memo(function MarkdownMath({
  tex,
  source,
  display,
}: {
  tex: string;
  source: string;
  display: boolean;
}) {
  const fallback = <span className="whitespace-pre-wrap">{source}</span>;
  return (
    <span
      className={
        display
          ? "my-2 block max-w-full overflow-x-auto"
          : "inline-block max-w-full overflow-x-auto align-middle"
      }
      data-markdown-math={display ? "display" : "inline"}
      data-markdown-copy={source}
      role="group"
      aria-label={display ? "Display equation" : "Inline equation"}
    >
      <RenderErrorBoundary resetKeys={[tex]} fallback={fallback}>
        <Suspense fallback={fallback}>
          <MathTypeset tex={tex} display={display} fallback={fallback} />
        </Suspense>
      </RenderErrorBoundary>
    </span>
  );
});
