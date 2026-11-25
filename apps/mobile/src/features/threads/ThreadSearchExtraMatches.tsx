import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentThreadSearchMatch,
  ThreadSearchResultsState,
} from "@t3tools/client-runtime/state/thread-search";
import { pendingThreadSearchJumpAtom } from "@t3tools/client-runtime/state/thread-search";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { appAtomRegistry } from "../../state/atom-registry";
import { usePrivacyLabel, usePrivacyMode } from "../../state/use-privacy-mode";
import {
  ThreadSearchMatchExcerpt,
  ThreadSearchMoreButton,
  ThreadSearchTitleText,
} from "./thread-search-match";

export function ThreadSearchExtraMatches(props: {
  readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>;
  readonly query: string;
  readonly pagination: ThreadSearchResultsState["pagination"];
  readonly onSelectThread: (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) => void;
}) {
  const privacy = usePrivacyMode();
  const privateLabel = usePrivacyLabel();
  if (!props.matches.length && !props.pagination) return null;
  const renderMatch = (match: EnvironmentThreadSearchMatch) => (
    <Pressable
      key={`${match.environmentId}:${match.threadId}`}
      accessibilityRole="button"
      className="gap-1 px-4 py-3"
      onPress={() => {
        appAtomRegistry.set(pendingThreadSearchJumpAtom, match.messageId ? match : null);
        props.onSelectThread({ environmentId: match.environmentId, id: match.threadId });
      }}
    >
      <Text className="text-base text-foreground" numberOfLines={2}>
        {privacy ? (
          privateLabel("Chat", match.threadId, "")
        ) : (
          <ThreadSearchTitleText
            title={match.title || "Untitled chat"}
            query={props.query}
            correction={match.titleCorrection}
          />
        )}
        {match.archived ? " · Archived" : ""}
      </Text>
      {!privacy ? <ThreadSearchMatchExcerpt match={match} query={props.query} /> : null}
    </Pressable>
  );
  const chatMatches = props.matches.filter((match) => match.messageId === null);
  const messageMatches = props.matches.filter((match) => match.messageId !== null);
  return (
    <View>
      {chatMatches.map(renderMatch)}
      {messageMatches.length ? (
        <Text
          accessibilityRole="header"
          className="px-4 pb-1 pt-3 text-xs font-t3-medium text-foreground-muted"
        >
          Messages
        </Text>
      ) : null}
      {messageMatches.map(renderMatch)}
      <ThreadSearchMoreButton pagination={props.pagination} />
    </View>
  );
}
