import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { RequestActionButton } from "./RequestActionButton";

/**
 * Replaces the composer on a delegated child while it is waiting on a question.
 * The parent agent answers that question, or asks the user from the parent chat.
 */
export function DelegatedQuestionBar(props: { readonly onOpenParent: (() => void) | null }) {
  return (
    <View className="flex-row items-center gap-3 rounded-[20px] border border-border-subtle bg-card-alt py-2 pe-2 ps-4">
      <View
        accessible
        accessibilityLabel="Question for the parent agent. It will ask you if it needs an answer. There is nothing to send here."
        className="min-w-0 flex-1 gap-0.5"
      >
        <Text numberOfLines={1} className="font-t3-bold text-sm text-foreground">
          Question for the parent agent
        </Text>
        <Text numberOfLines={2} className="font-sans text-xs text-foreground-secondary">
          It will ask you if it needs an answer
        </Text>
      </View>
      {props.onOpenParent ? (
        <RequestActionButton label="Open parent" tone="secondary" onPress={props.onOpenParent} />
      ) : null}
    </View>
  );
}
