import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import { pendingThreadSearchJumpAtom } from "@t3tools/client-runtime/state/thread-search";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { appAtomRegistry } from "../../state/atom-registry";
import { ThreadSearchMatchExcerpt } from "./thread-search-match";

export function ThreadSearchExtraMatches(props: {
  readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>;
  readonly query: string;
  readonly onSelectThread: (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) => void;
}) {
  if (!props.matches.length) return null;
  return (
    <View>
      {props.matches.map((match) => (
        <Pressable
          key={`${match.environmentId}:${match.threadId}`}
          accessibilityRole="button"
          className="gap-1 px-4 py-3"
          onPress={() => {
            if (match.messageId) appAtomRegistry.set(pendingThreadSearchJumpAtom, match);
            props.onSelectThread({ environmentId: match.environmentId, id: match.threadId });
          }}
        >
          <Text className="text-base text-foreground">
            {match.title || "Untitled chat"}
            {match.archived ? " · Archived" : ""}
          </Text>
          <ThreadSearchMatchExcerpt match={match} query={props.query} />
        </Pressable>
      ))}
    </View>
  );
}
