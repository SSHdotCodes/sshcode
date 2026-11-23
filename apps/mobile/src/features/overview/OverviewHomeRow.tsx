import { useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { HarnessMascot } from "../../components/HarnessMascot";
import { useOverviewEnabled, useOverviewEnvironmentId, useOverviewThread } from "./useOverview";

/** Overview chip in the Home shortcuts row. */
export function OverviewHomeRow() {
  const navigation = useNavigation();
  const [enabled] = useOverviewEnabled();
  const thread = useOverviewThread(useOverviewEnvironmentId());
  if (!enabled) return null;
  const looking = thread?.activityRunStatus != null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Overview"
      accessibilityHint="Ask what your chats are up to"
      onPress={() => {
        void Haptics.selectionAsync();
        navigation.navigate("Overview");
      }}
      hitSlop={6}
      className="h-8 flex-row items-center gap-1.5 rounded-full border border-border px-3 active:opacity-60"
    >
      <HarnessMascot driver="claudeAgent" state={looking ? "working" : "idle"} size={18} />
      <Text className="shrink text-sm text-foreground" numberOfLines={1}>
        Overview
      </Text>
    </Pressable>
  );
}
