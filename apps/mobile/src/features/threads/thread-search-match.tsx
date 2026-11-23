import { focusThreadSearchSnippet, splitThreadSearchText } from "@t3tools/shared/threadSearch";
import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";

export function ThreadSearchMatchExcerpt(props: {
  readonly match: EnvironmentThreadSearchMatch;
  readonly query: string;
  readonly selected?: boolean;
  readonly compact?: boolean;
  readonly sidebar?: boolean;
}) {
  if (props.match.messageId === null) return null;
  const isUser = props.match.source === "user";
  // One line shows about 35 characters: start near the match, not at the snippet's first word.
  const parts = splitThreadSearchText(
    focusThreadSearchSnippet(props.match.snippet, props.query),
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
      numberOfLines={1}
    >
      <Text
        className={cn(
          props.compact ? "text-sm font-t3-medium" : "text-xs font-t3-medium",
          props.selected
            ? "text-thread-selected-foreground"
            : isUser
              ? props.sidebar
                ? "text-drawer-foreground-muted"
                : "text-foreground-secondary"
              : "text-adaptive-emerald-600-400",
        )}
      >
        {isUser ? "You:" : "Agent:"}{" "}
      </Text>
      {props.match.archived ? "Archived · " : ""}
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
