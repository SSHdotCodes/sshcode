import type { OrchestrationThreadSearchMatch } from "@t3tools/contracts";
import type { ThreadSearchResultsState } from "@t3tools/client-runtime/state/thread-search";
import { focusThreadSearchSnippet, splitThreadSearchExcerpt } from "@t3tools/shared/threadSearch";
import { ChevronDownIcon, RotateCwIcon } from "lucide-react";

import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";

export function HighlightedSearchText(props: {
  readonly text: string;
  readonly query: string;
  readonly correction?: string | undefined;
}) {
  return splitThreadSearchExcerpt(props.text, props.query, props.correction).map((part) =>
    part.highlighted ? (
      <mark
        className="rounded-sm bg-primary/14 px-0.5 font-medium text-foreground dark:bg-primary/22"
        key={part.start}
      >
        {part.text}
      </mark>
    ) : (
      part.text
    ),
  );
}

export function ThreadSearchMatchExcerpt(props: {
  readonly match: Pick<OrchestrationThreadSearchMatch, "source" | "snippet"> & {
    readonly query: string;
    readonly messageId?: string | null;
    readonly matchedModel?: string;
    readonly matchedHarness?: string;
  };
}) {
  const { matchedModel, matchedHarness, messageId, query, snippet, source } = props.match;
  if (messageId === null && !matchedModel && !matchedHarness) return null;
  const context = [matchedHarness, matchedModel].filter(Boolean).join(" · ");
  return (
    <span className="truncate text-xs text-muted-foreground/85">
      {matchedHarness
        ? "Harness:"
        : matchedModel
          ? "Model:"
          : source === "user"
            ? "You:"
            : "Agent:"}{" "}
      <HighlightedSearchText
        text={context || focusThreadSearchSnippet(snippet, query)}
        query={query}
      />
    </span>
  );
}

export function ThreadSearchMoreButton(props: {
  readonly pagination: ThreadSearchResultsState["pagination"];
  readonly className?: string;
}) {
  const { pagination, className } = props;
  if (!pagination) return null;
  return (
    <button
      type="button"
      disabled={pagination.isLoading}
      onClick={pagination.loadMore}
      className={cn(
        "mt-0.5 flex h-9 w-full shrink-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-left text-xs font-medium text-sidebar-muted-foreground outline-none transition-[background-color,color,scale] duration-120 ease-out motion-reduce:transition-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground active:scale-[0.99] active:bg-sidebar-row-active motion-reduce:active:scale-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:opacity-60",
        className,
      )}
    >
      {pagination.isLoading ? (
        <Spinner size="xs" aria-hidden className="shrink-0" />
      ) : pagination.failed ? (
        <RotateCwIcon aria-hidden className="size-3.5 shrink-0 opacity-75" />
      ) : (
        <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 opacity-75" />
      )}
      <span className="truncate">
        {pagination.isLoading
          ? "Searching more…"
          : pagination.failed
            ? "Retry more results"
            : "More results"}
      </span>
    </button>
  );
}
