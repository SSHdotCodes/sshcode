import { focusThreadSearchSnippet, splitThreadSearchExcerpt } from "@t3tools/shared/threadSearch";
import type {
  EnvironmentThreadSearchMatch,
  ThreadSearchResultsState,
} from "@t3tools/client-runtime/state/thread-search";
import { Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";

export function ThreadSearchTitleText(props: {
  readonly title: string;
  readonly query?: string | undefined;
  readonly correction?: string | undefined;
}) {
  if (!props.query) return props.title;
  return splitThreadSearchExcerpt(props.title, props.query, props.correction).map((part) =>
    part.highlighted ? (
      <Text className="font-t3-bold" key={part.start}>
        {part.text}
      </Text>
    ) : (
      part.text
    ),
  );
}

export function ThreadSearchMatchExcerpt(props: {
  readonly match: EnvironmentThreadSearchMatch;
  readonly query: string;
  readonly selected?: boolean;
  readonly compact?: boolean;
  readonly sidebar?: boolean;
}) {
  const { matchedModel, matchedHarness, messageId } = props.match;
  if (messageId === null && !matchedModel && !matchedHarness) return null;
  const context = [matchedHarness, matchedModel].filter(Boolean).join(" · ");
  const isUser = props.match.source === "user";
  const parts = splitThreadSearchExcerpt(
    context || focusThreadSearchSnippet(props.match.snippet, props.query),
    props.query,
  );
  return (
    <Text
      className={cn(
        props.compact ? "text-sm" : "text-xs",
        props.selected
          ? "text-thread-selected-foreground-muted"
          : props.sidebar
            ? "text-drawer-foreground-muted"
            : "text-foreground-muted",
      )}
      numberOfLines={2}
    >
      {matchedHarness ? "Harness:" : matchedModel ? "Model:" : isUser ? "You:" : "Agent:"}{" "}
      {parts.map((part) => (
        <Text
          className={cn(
            props.compact ? "text-sm" : "text-xs",
            part.highlighted && "font-t3-bold",
            props.selected
              ? "text-thread-selected-foreground"
              : part.highlighted
                ? props.sidebar
                  ? "text-drawer-foreground"
                  : "text-foreground"
                : props.sidebar
                  ? "text-drawer-foreground-muted"
                  : "text-foreground-muted",
          )}
          key={part.start}
        >
          {part.text}
        </Text>
      ))}
    </Text>
  );
}

export function ThreadSearchMoreButton(props: {
  readonly pagination: ThreadSearchResultsState["pagination"];
}) {
  const { pagination } = props;
  if (!pagination) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: pagination.isLoading, busy: pagination.isLoading }}
      className="min-h-11 justify-center px-4"
      disabled={pagination.isLoading}
      onPress={pagination.loadMore}
    >
      <Text className="text-sm text-foreground-muted">
        {pagination.isLoading
          ? "Searching more…"
          : pagination.failed
            ? "Retry more results"
            : "More results"}
      </Text>
    </Pressable>
  );
}
