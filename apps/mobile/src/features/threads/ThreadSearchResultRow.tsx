import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import { pendingThreadSearchJumpAtom } from "@t3tools/client-runtime/state/thread-search";
import { Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { appAtomRegistry } from "../../state/atom-registry";
import { usePrivacyLabel, usePrivacyMode } from "../../state/use-privacy-mode";
import { ThreadSearchMatchExcerpt, ThreadSearchTitleText } from "./thread-search-match";

export function ThreadSearchResultRow(props: {
  readonly match: EnvironmentThreadSearchMatch;
  readonly query: string;
  readonly onSelectThread: (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) => void;
}) {
  const privacy = usePrivacyMode();
  const privateLabel = usePrivacyLabel();
  const { match } = props;
  return (
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
}
