import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { Alert, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { pendingSends, pendingSendMetadata } from "../../state/pending-sends";

/** Keep auxiliary sends visible when their side sheet or question card is closed. */
export function PendingSendNotice(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly visibleRequestIds: ReadonlyArray<RuntimeRequestId>;
  readonly onOpenSideChat: () => void;
  /** Float this far from the top, below a header that overlaps the content. */
  readonly top?: number;
}) {
  const sends = useAtomValue(pendingSends.awaitingAckAtom).filter(
    (send) =>
      send.environmentId === props.environmentId &&
      send.threadId === props.threadId &&
      (send.kind === "side-question" || !props.visibleRequestIds.includes(send.requestId)),
  );
  if (sends.length === 0) return null;
  return (
    <View
      className="gap-2 px-4 py-2"
      pointerEvents="box-none"
      style={
        props.top === undefined
          ? undefined
          : { position: "absolute", top: props.top, left: 0, right: 0, zIndex: 20 }
      }
    >
      {sends.map((send) => (
        <View key={send.id} className="gap-1 rounded-2xl bg-subtle px-3 py-2">
          <Text className="text-sm text-foreground-secondary" accessibilityLiveRegion="polite">
            {send.error ??
              (send.kind === "side-question"
                ? "Side question waiting for network…"
                : "Answer waiting for network…")}
          </Text>
          <Text selectable numberOfLines={2} className="text-sm text-foreground">
            {send.kind === "side-question"
              ? send.prompt
              : Object.values(send.answers)
                  .flatMap((answer) =>
                    typeof answer === "string"
                      ? [answer]
                      : Array.isArray(answer)
                        ? answer.filter((value) => typeof value === "string")
                        : [],
                  )
                  .join(" · ") || "Your answer is saved on this phone."}
          </Text>
          {send.kind === "side-question" ? (
            <Pressable
              accessibilityRole="button"
              className="min-h-11 justify-center"
              onPress={props.onOpenSideChat}
            >
              <Text className="text-sm font-t3-medium text-foreground">Open side question</Text>
            </Pressable>
          ) : send.error ? (
            <Pressable
              accessibilityRole="button"
              className="min-h-11 justify-center"
              onPress={() => {
                const { error: _, ...retry } = send;
                void pendingSends.enqueue({ ...retry, ...pendingSendMetadata() }).catch(() => {
                  Alert.alert(
                    "Could not retry the answer",
                    "Your answer is still saved. Try again.",
                  );
                });
              }}
            >
              <Text className="text-sm font-t3-medium text-foreground">Try again</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
    </View>
  );
}
