import { WorkflowsHomeRow } from "../workflows/WorkflowsHomeRow";
import { Host, Picker, Text } from "@expo/ui/swift-ui";
import { pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import { StackActions, useNavigation } from "@react-navigation/native";
import { Keyboard, Pressable, View } from "react-native";
import { SymbolView } from "../../components/AppSymbol";
import { AppText } from "../../components/AppText";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import type { WorkspaceTab } from "./workspace-tabs-state";

/** Wide iPad navigation belongs to the sidebar, leaving the detail's header unobstructed. */
export function WorkspaceSidebarTabs() {
  const workspace = useWorkspaceTabs()!;
  const navigation = useNavigation();
  const { themeAppearance } = useAppearancePreferences();
  return (
    <View className="px-4 pb-3 pt-2">
      <Host
        matchContents={{ vertical: true }}
        colorScheme={themeAppearance}
        style={{ width: "100%" }}
      >
        <Picker
          label="Workspace"
          selection={workspace.state.selectedTab}
          onSelectionChange={(tab: WorkspaceTab) => {
            if (tab === workspace.state.selectedTab) return;
            Keyboard.dismiss();
            if (navigation.getState()?.index) navigation.dispatch(StackActions.popToTop());
            workspace.dispatch({ type: "select", tab });
          }}
          modifiers={[pickerStyle("segmented")]}
        >
          <Text modifiers={[tag("threads")]}>Chats</Text>
          <Text modifiers={[tag("pullRequests")]}>Pull requests</Text>
        </Picker>
      </Host>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Notes"
        onPress={() => {
          Keyboard.dismiss();
          navigation.navigate("Notes");
        }}
        className="mt-2 min-h-11 flex-row items-center gap-3 rounded-xl px-3"
      >
        <SymbolView name="checklist" size={20} tintColorClassName="accent-icon" />
        <AppText>Notes</AppText>
      </Pressable>
      <WorkflowsHomeRow />
    </View>
  );
}
