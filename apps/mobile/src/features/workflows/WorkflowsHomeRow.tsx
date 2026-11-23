import { useNavigation } from "@react-navigation/native";
import { Pressable } from "react-native";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useWorkflowsEnabled } from "./state";

export function WorkflowsHomeRow() {
  const [enabled] = useWorkflowsEnabled();
  const navigation = useNavigation();
  if (!enabled) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Workflows"
      onPress={() => navigation.navigate("Workflows")}
      hitSlop={6}
      className="h-8 flex-row items-center gap-1.5 rounded-full border border-border px-3 active:opacity-60"
    >
      <SymbolView name="arrow.triangle.branch" size={14} tintColorClassName="accent-primary" />
      <Text className="shrink text-sm text-foreground" numberOfLines={1}>
        Workflows
      </Text>
      <Text className="text-[11px] text-foreground-muted">Beta</Text>
    </Pressable>
  );
}
